# Desenho de persistência: leitura das decisões que devolvem (#8)

Issue: #8, plano da história #1 (AC-1 a AC-8). Banco: PostgreSQL 17 no Supabase (`supabase/config.toml`, `[db] major_version = 17`), acessado pelo PostgREST a partir de um Cloudflare Worker. Registro: `supabase/persistence-modes.yaml`.

**Em uma frase:** a #8 não precisa de migração. O adaptador de `DecidedReturnSource` `listDecided` faz 4 leituras fixas (Q1 propostas com recursos embutidos, Q2 recebimentos em 2 requisições e Q3 produtos). Uma rodada da varredura soma 1 leitura da fila, ou seja, 5 `GET`, mais 1 `POST` por nota nova. A única gravação é o insert idempotente que já existe em `outbox_return_notes`.

## Entradas

| Entrada | Valor | Fonte |
|---|---|---|
| Grupos e entidades principais | Nota fiscal (`invoices`, com `divergences`, `proposals`, `approvals` no mesmo grupo, `docs/domain/README.md`); nota de devolução (`outbox_return_notes`, a mensagem que a decisão gera); recebimento e produto são do kit | domínio, #1 |
| Consultas | Q1 decididas com aprovação e nota; Q2 recebimentos com itens; Q3 cadastro de produtos; Q4 fila de devolução inteira; Q5 gravação idempotente | `api/src/returns/*`, `api/src/connectors/*`, #8 |
| Inquilino | nenhum | a Já Chegou é uma empresa só |
| Números assumidos | propostas decididas, linhas da fila: abaixo de 1000 cada (uma página, `max_rows = 1000` em `supabase/config.toml` e `DEFAULT_PAGE_SIZE` de `supabase-rest.ts`); volume diário não informado ("poucas notas por dia", `supabase-store.ts`); kit: 71 recebimentos, 37 produtos, 80 notas (`data/kit/`) | não informado pela issue |

## Tabelas

| Tabela | Modo | Por quê: fato ou entidade editada | Histórico: forma e lugar | Versão | Inquilino |
|---|---|---|---|---|---|
| `approvals` | append-only | a decisão é um fato, uma por proposta (`approvals_proposal_key`) | nenhum; a linha é o fato | n/a | nenhum |
| `proposals` | upsert-with-history | a pessoa altera ação e justificativa | **falta**: a decisão sobrescreve `dock_action` e `justification` | **falta** | nenhum |
| `invoices` | upsert-with-history | estado e conferência gravados por cima; os itens não mudam | **falta** | **falta** | nenhum |
| `divergences` | append-only | achados da conferência | nenhum | n/a | nenhum |
| `outbox_return_notes` | upsert-with-history | o payload é o fato; o status sai de `pendente` uma vez (#140) | `in-row-transition`: quem e quando nas colunas `emitted_*` e `cancelled_*`, o estado anterior é sempre `pendente` | `status` (o PATCH filtra `status=eq.pendente`) | nenhum |
| `kit_*` (13 tabelas) | ephemeral, `growth: fixed` | espelho de `data/kit/*.json` recarregado por `scripts/load_kit.py` (ADR-001) | n/a | n/a | nenhum |

A #8 não muda o modo de nenhuma tabela: só lê as cinco primeiras e o kit, e só insere em `outbox_return_notes`. As lacunas de `proposals` e `invoices` já existiam e são dos donos do #59 e do #63 (ver Em aberto).

## Leituras e gravação do adaptador

**Q1, uma requisição.** Propostas decididas, cada uma com a sua aprovação e a sua nota, pelo embedding do PostgREST:

```
GET proposals?select=id,invoice_access_key,classification,state,dock_action,
    approvals(decided_on,approved_at),
    invoices(access_key,number,series,supplier_id,store,issued_on,purchase_order_ref,entry_channel,total_cents,items,state,
             divergences(invoice_access_key,seq,classification,skus,evidence))
  &state=in.(aprovada,alterada)&order=id
```

O PostgREST junta tabelas pelas chaves estrangeiras e monta os recursos relacionados numa só chamada ([Resource Embedding](https://docs.postgrest.org/en/stable/references/api/resource_embedding.html)). `proposals_invoice_fkey` dá a relação muitos-para-um com `invoices`, e `approvals_proposal_fkey`, com a restrição única `approvals_proposal_key`, dá a relação um-para-um com `approvals` (mesma página: "when the foreign key has a unique constraint"). `divergences_invoice_fkey` dá as divergências da nota. Só entram se o adaptador remonta o `Invoice` por `invoiceFromRows`; senão, fica fora do `select`. Toda requisição roda numa transação ([PostgREST: Transactions](https://docs.postgrest.org/en/stable/references/transactions.html)), então proposta, aprovação e nota saem de uma única transação somente leitura. Também não há filtro `in.(...)` cuja URL cresceria com cada decisão. `decided_on` nulo cai em `approved_at`, cortado no dia, como em `approvalFromRow`.

O `FakePostgrest` (`api/test/support/fake-postgrest.ts`) entende `select` com recurso embutido: esta camada o estendeu, com o mapa das três relações acima. Se não quiser estender, o caminho que resta é o de `SupabaseApprovalStore.load`: `proposals`, depois `approvals` e `invoices` com `in.(...)` em paralelo, ou seja, três requisições. Ele tem dois custos: a URL cresce com as decisões e as leituras saem de transações separadas. Nenhuma página lida aqui diz o tamanho máximo de URL do PostgREST (ver Em aberto).

**Q2, duas requisições.** `WmsCountConnector.listReceipts()` já lê `kit_recebimentos` e `kit_recebimento_itens` inteiras. As tabelas são fixas, e `mergeReceipts` filtra pela chave e pelo dia da decisão.

**Q3, uma requisição.** `ErpRegistryConnector.listProducts()` já lê `kit_produtos` inteira.

**Q4, uma requisição.** A varredura chama `outbox.list()` (`SupabaseOutbox.list`), que lê `outbox_return_notes` inteira em ordem de `id`.

**Q5, gravação.** `erpReturnNoteOutbox(rest).publish(note)` faz um `POST` com `on_conflict=idempotency_key` e `resolution=ignore-duplicates` ([PostgREST: Tables and Views, upsert](https://docs.postgrest.org/en/stable/references/api/tables_views.html)). Quando a linha já existe, um `GET` por `idempotency_key` a devolve. Nada muda nessa gravação.

**Orçamento do Cron.** Uma rodada da varredura faz 4 leituras (Q1 a Q3), mais 1 da fila (Q4), mais 1 `POST` por devolução nova. O número de leituras não muda enquanto cada uma couber em uma página de 1000 linhas. O teste de integração conta `fake.requests` numa rodada e afirma `5 + novas`. Se um dia cada página passar de 1000 linhas, a solução é a janela da seção Em aberto, não um índice.

## Índices

Nenhum índice novo. Nenhuma migração.

| Consulta | Plano esperado e índice que a serve | Por quê |
|---|---|---|
| Q1 filtro `proposals.state in (aprovada, alterada)` | leitura sequencial de `proposals` | toda proposta termina `aprovada` ou `alterada`, então o filtro pega quase a tabela toda. O PostgreSQL não usa índice para um valor que é "more than a few percent of all the table rows" ([Partial Indexes](https://www.postgresql.org/docs/17/indexes-partial.html)). Um índice em `state` não serviria a nenhuma consulta (IDX-2) |
| Q1 junção com `invoices` | `invoices_pkey (access_key)` | chave primária |
| Q1 junção com `approvals` | `approvals_proposal_key (proposal_id)` | restrição única, primeira coluna é a da junção |
| Q1 junção com `divergences` | `divergences_pkey (invoice_access_key, seq)` | a primeira coluna é a da junção |
| Q2, Q3 | leitura inteira | `kit_*` é `growth: fixed` |
| Q4 | leitura inteira em ordem de `outbox_return_notes_pkey (id)` | o caso de uso pede a fila toda para saber quais notas já entraram |
| Q5 conflito e releitura | `outbox_return_notes_idempotency_key_key` | restrição única |

`outbox_return_notes_status_idx (status, id)` (#140) continua servindo `supabaseReturnNoteQueue.list`. A #8 não o usa e não o muda.

## Transações

| Caso de uso | Unidade de trabalho aberta em | Raiz alterada | Gravações | Em caso de falha | Efeito em outra raiz |
|---|---|---|---|---|---|
| `publishReturnNote` (uma decisão) | o `POST` único em `outbox_return_notes`: uma requisição do PostgREST é uma transação | a nota de devolução | uma linha (payload, chave de idempotência; status `pendente` por padrão) | o PostgREST encerra a transação da requisição e nada fica gravado. O erro sobe como `SupabaseRestError`, sem dados. Uma linha duplicada não é erro: a linha existente volta | nenhum. A própria linha é o evento da decisão, já gravada em `approvals` |
| `sweepReturnNotes` | nenhuma. Q1 a Q4 são leituras (somente leitura no PostgREST), e cada publicação é a sua própria transação, como acima | as notas de devolução, uma por vez | um `POST` por devolução nova | as publicações anteriores ficam, o que está certo: cada uma é independente e idempotente. A exceção para a varredura, e a rodada seguinte retoma de onde parou | nenhum |

Não há conexão nem transação aberta no Worker: o adaptador não guarda sessão, e cada requisição HTTP tem início e fim no PostgREST. Por isso nenhuma transação fica pendurada (TRX-4).

**O que não fecha numa transação só.** A nota de devolução não é gravada na mesma transação da decisão (TRX-3). `saveDecision` e `proposeChecked` gravam a decisão em várias requisições, e a publicação vem depois. Nada se perde, por três razões. O fato da decisão está em `approvals` e `proposals`. A varredura deriva a nota de novo a cada rodada (AC-6). A chave de idempotência impede uma segunda linha para o mesmo payload (AC-7). Fechar a decisão e a nota numa transação só pediria uma função `rpc` no banco, e isso muda a estratégia `postgrest-request`, que agora está registrada: fica fora da #8.

## Estratégia de inquilino

Não há inquilino. `strategies.tenancy.strategy: none`. O RLS ligado e sem política das migrações continua sendo a regra de acesso do projeto ("só o Worker lê e grava, com a chave secreta", `20261115130000_dominio.sql`). Não é isolamento entre clientes.

## Conferência das regras

| Condição | Cumprida por | Não cumprida, e por quê |
|---|---|---|
| PER-1 | as tabelas da #8 e todo o `kit_*` no registro | dez tabelas fora da #8 ainda sem modo (lista no topo do registro) |
| PER-2 | `approvals`, `divergences`: a #8 não as grava | `divergences` recebe upsert em `invoice-store.ts`. O banco não recusa `UPDATE` porque o Worker não tem papel próprio (`refusal: access-layer`) |
| PER-3, PER-4 | `outbox_return_notes`: uma transição, com quem e quando e o filtro por `status` | `proposals` e `invoices` sem versão nem histórico (lacuna anterior à #8) |
| PER-5 | a #8 não apaga | `ops/reconferir.ts` apaga as tabelas do domínio (#56) |
| PER-6 | `approvals`: uma linha por proposta, lida direto | n/a |
| PER-7 | nenhum modo muda | a #8 acrescenta ao registro |
| PER-8 | histórico declarado por tabela | `in-row-transition` é extensão deste projeto, fora das formas de `docs/entity-history.md` |
| TRX-1 | cada gravação é um `POST`, numa transação | n/a |
| TRX-2 | nenhum adaptador emite `BEGIN` ou `COMMIT`. A transação é a da requisição | não há porta de unidade de trabalho: a borda é a requisição |
| TRX-3 | `publishReturnNote` grava uma raiz | a nota não sai na transação da decisão (ver Transações) |
| TRX-4 | o PostgREST encerra toda transação de requisição | sem teste de falha forçada no banco real: os testes usam o `FakePostgrest` |
| IDX-1 | junções pelas chaves | Q1 em `proposals` e Q4 leem a tabela inteira por desenho. Não há plano lido em teste porque não existe banco real nos testes |
| IDX-2 | nenhum índice novo | n/a |
| IDX-3 | n/a: banco relacional | n/a |
| IDX-4 | nenhum índice novo | n/a |
| MT-1 a MT-5 | n/a: não há inquilino | n/a |

## Testes que a #8 traz (com o `FakePostgrest`)

- AC-1: o adaptador devolve as propostas `aprovada` e `alterada` com a ação, o dia da decisão (e o `approved_at` quando `decided_on` é nulo), a nota e os recebimentos dela. `registrada` e `aguardando_aprovacao` ficam fora.
- AC-2: publicar a mesma devolução duas vezes deixa uma linha só em `outbox_return_notes`.
- AC-3: uma linha fora do formato em cada tabela lida vira `SupabaseRestError` de `parse`, e a mensagem não traz a linha.
- Orçamento: uma rodada de `sweepReturnNotes` sobre a fonte Supabase faz `5 + novas` requisições em `fake.requests`, e com tudo já na fila faz 5 e não grava nada.

## Em aberto

1. **A janela da varredura.** Q1 e Q4 leem tudo, para sempre, como a porta `listDecided()` pede. Quando qualquer uma delas passar de 1000 linhas, a leitura vira mais de uma página e o número de requisições deixa de ser fixo. A saída seria filtrar `approvals.decided_on >= hoje - N` (como `PUBLISH_WINDOW_DAYS = 7` do #66), com índice em `approvals (decided_on)` criado `CONCURRENTLY` numa migração própria. O custo é que a decisão cuja publicação falhar por mais de N dias não entra mais na fila. A decisão é de produto e muda a porta da #7. Quem decide é o dono da #1, pela Athena, antes do volume chegar lá.
2. **A primeira rodada depois da entrada em produção.** Todas as decisões antigas que devolvem são publicadas na primeira rodada, com um `POST` cada, e o Cron tem cerca de 50 subrequisições divididas entre os passos. Há duas saídas na camada da API (#1): limitar as publicações por rodada ou mandar as novas num único `POST` com várias linhas (`SupabaseRest.insert` já aceita). Responde a Athena.
3. **Duas linhas para a mesma nota.** A idempotência é por payload. Se a rota e a varredura correm juntas e leem recebimentos ou fator de caixa diferentes, os dois payloads saem diferentes e entram duas linhas. Uma restrição única por `invoice_access_key` mudaria a estratégia de idempotência registrada (#59) e o #140. Responde o mantenedor; a #8 mantém a estratégia como está.
4. **Lacunas anteriores à #8.** `proposals` e `invoices` sem versão nem histórico, a ação proposta pelo agente perdida no `alterada`, a decisão gravada em várias requisições sem atomicidade (`saveDecision`), a reconferência que apaga tudo. São decisões dos donos do #59, #63 e #56.
5. **Tamanho de URL.** Só importa se o caminho alternativo de Q1, com `in.(...)`, for o escolhido. Nenhuma página lida aqui dá o limite. Quem constrói confere na documentação do Supabase antes de escolher esse caminho.
