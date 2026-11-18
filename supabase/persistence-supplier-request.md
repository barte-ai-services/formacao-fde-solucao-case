# Desenho da persistência: pedido ao fornecedor (#12)

Issue: #12 (história #2). Banco: PostgreSQL 17 no Supabase (`supabase/config.toml`, `major_version = 17`), acessado só por PostgREST com a chave secreta. Registro: `supabase/persistence-modes.yaml`. Migração desta camada: `supabase/migrations/20261117160000_supplier_request.sql` (posterior à última, `20261116100000`).

## Entradas

| Entrada | Valor | Fonte |
|---|---|---|
| Raízes | `SupplierRequest` (pedido ao fornecedor); `IssuedReturnNote` (a nota emitida pelo mock, valor imutável); a entrada da fila `outbox_return_notes` (existente, #140) | `api/src/domain/supplier-request.ts`, `return-note-document.ts`, `api/src/returns/return-notes.ts` |
| Consultas | Q1 `findOpen(invoice_access_key, request_type)` entre `draft`, `sent`, `send_failed`; Q1b `listOpenKeys(request_type, invoice_access_keys)`: das notas de origem pendentes na fila, as com pedido aberto do tipo, numa leitura só limitada por `invoice_access_key=in.(<chaves pendentes>)` e feita depois da leitura da fila (o `pending()` da tarefa do Cron, em vez de um `findOpen` por devolução; sem chave pendente, nenhuma leitura; mesmo predicado do índice parcial, então o payload não cresce com os pedidos enviados do histórico); Q2 `get(id)`; Q3 `issue(queueId)`: a nota já emitida da devolução; Q4 `SourceInvoices.find`: `invoices` por `access_key` e `kit_fornecedores` por `fornecedor_id`; Q5 o pedido por id na trava e nas gravações; Q6 `findLatest(invoice_access_key, request_type)`: o mais recente da nota e do tipo, `order=id.desc&limit=1`; Q7 `listByStatus(status, limit)`: os mais novos do estado, `status=eq.<estado>&order=id.desc&limit=<n>` | `api/src/supplier/ports.ts`, `draft.ts`, `use-cases.ts` |
| Inquilino | nenhum | brief da #12 |
| Números assumidos | pedidos por dia: não informado; entradas de histórico por pedido: poucas dezenas (rascunho, edições, emissão, tentativas de envio), assumido; prazo da trava do envio: 5 minutos, assumido (não informado o tempo máximo do envio de e-mail) | |

## Tabelas

| Tabela | Modo | Por quê: fato ou entidade editada | Histórico: forma e lugar | Versão | Inquilino |
|---|---|---|---|---|---|
| `issued_return_notes` | append-only | fato: o mock emitiu a nota tal dia com tal número; não muda depois | nenhum (o log é a própria tabela); recusa de `UPDATE`/`DELETE` por grant | n/a | nenhum |
| `outbox_supplier_emails` | upsert-with-history | entidade editada: a pessoa troca o corpo do rascunho, e o estado anda (`draft` → `sent`/`send_failed`/`discarded`) | coluna `history jsonb` na própria linha: cada gravação acrescenta `{version, at, by, action, state}` com o estado inteiro depois | `version integer` | nenhum |
| `kit_fornecedores` (só `+ email`) | ephemeral | cópia fiel de `data/kit/fornecedores.json`, refeita pela carga; o registro é o JSON no git | nenhum (razão no registro) | n/a | nenhum |

### Por que o histórico fica numa coluna, e não numa tabela filha

O PostgreSQL guarda `jsonb` indexável ([jsonb Indexing](https://www.postgresql.org/docs/current/datatype-json.html#JSON-INDEXING)), e o padrão do plugin prefere a tabela filha `(id, version, at, by, state)`. Mas aqui cada requisição PostgREST é uma transação e toca uma tabela ([PostgREST: Transactions](https://docs.postgrest.org/en/stable/references/transactions.html): "every request to an API resource runs inside a transaction", "Any database failure(like a failed constraint) will result in a rollback"), e o cliente da api não chama RPC (`supabase-rest.ts` só tem select, insert, upsert, update e delete). Com tabela filha, entidade e histórico seriam duas requisições e duas transações, contra PER-3 e TRX-1. Na coluna, um só `PATCH` grava estado, histórico e versão juntos. O histórico de um pedido é curto e lido com ele, que é o caso em que `docs/entity-history.md` admite a coluna. A ADR-005 já recusou a tabela de auditoria alimentada por gatilho; a coluna segue o que ela decidiu (o carimbo mora na linha).

### `issued_return_notes`: colunas

- `id bigint generated always as identity (maxvalue 999999999)`, chave primária. **É a sequência da emissão**: `noteId = ND-<id>`, `number = <id>`, série 9. O teto é o mesmo do domínio (`MAX_SEQUENCE`).
- `queue_id bigint not null`, referência por identidade a `outbox_return_notes(id)` sem FK (ver Índices), `unique (queue_id)`: uma nota por devolução da fila (AC-2).
- `invoice_access_key text not null` (a nota de origem, `referencedAccessKey`), `supplier_id text not null` FK `kit_fornecedores(fornecedor_id)`.
- `issued_on date not null`, `note jsonb not null` (o `ReturnNoteDraft` como a regra montou; `check (jsonb_typeof(note) = 'object')`), `created_at timestamptz not null default now()` (ADR-005).
- A chave de acesso de 44 algarismos e o emitente **não** são colunas: `issueReturnNote(note, { sequence: id, issuedOn: issued_on })` é determinística e a reconstrói igual a cada leitura. Gravá-la pediria saber o `id` antes do `insert`, o que exigiria RPC ou um segundo `UPDATE` (proibido no append-only). Se o algoritmo da chave mudar, as notas antigas mudam de chave: a mudança da função é uma mudança de contrato desta tabela.
- `revoke update, delete, truncate on public.issued_return_notes from anon, authenticated, service_role` ([Privileges](https://www.postgresql.org/docs/current/ddl-priv.html)). A chave secreta usa o papel `service_role`, que tem `BYPASSRLS` ([Supabase: API keys](https://supabase.com/docs/guides/api/api-keys)); RLS não recusa nada para ela, o grant recusa.

### `outbox_supplier_emails`: colunas

- `id bigint generated always as identity` primary key: o `id` que `SupplierRequest.draft/rejected` recebe de quem grava.
- `invoice_access_key text not null`; `queue_id bigint not null`, referência por identidade a `outbox_return_notes(id)` sem FK (ver Índices); `supplier_id text not null` FK `kit_fornecedores(fornecedor_id)`; `request_type text not null check (request_type in ('return_note'))` `-- ADR-002`.
- `recipient text not null` (o `to` do e-mail; `to` é palavra reservada do SQL e pediria aspas em todo filtro); `subject text not null`, `body text not null` (a forma com `{{chave}}`, como a raiz guarda), `asks jsonb not null check (jsonb_typeof(asks) = 'array')`. O pedido recusado nasce com `''`, `''` e `[]`, como `SupplierRequest.rejected`.
- `note jsonb not null` (o `ReturnNoteDraft` congelado do pedido), `attachments jsonb not null default '[]'` com `check (jsonb_typeof(attachments) = 'array')`: no envio, `{filename, content_type, issued_return_note_id}` de cada anexo; o conteúdo não é copiado, sai da nota emitida (append-only).
- `drafted_on date not null`, `due_on date not null`, `model text not null`.
- `status text not null check (status in ('draft', 'sent', 'send_failed', 'discarded'))` `-- ADR-002`; `discard_reason text`, `send_failure_reason text`.
- `issued_return_note_id bigint` FK `issued_return_notes(id)`.
- `channel text check (channel in ('mock', 'resend'))` `-- ADR-002`, `provider_message_id text`, `sent_by text`, `sent_at timestamptz`, `discarded_by text`, `discarded_at timestamptz` (ADR-005: só os atos humanos; sem `created_by`/`updated_by`).
- `version integer not null default 1`, `history jsonb not null default '[]'` (`check (jsonb_typeof(history) = 'array')`), `send_claim uuid`, `send_claimed_at timestamptz`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`.
- Coerência, no estilo da fila (#140): `(status = 'sent') = (sent_by is not null and sent_at is not null and channel is not null and provider_message_id is not null)`; `(status = 'discarded') = (discard_reason is not null)`; `(discarded_by is null) = (discarded_at is null)`; `status <> 'send_failed' or send_failure_reason is not null`; `status <> 'sent' or request_type <> 'return_note' or issued_return_note_id is not null`; `(send_claim is null) = (send_claimed_at is null)`. O `send_failure_reason` fica depois de `sent`, como a raiz o guarda.
- Nenhum `DELETE`: o fim de um pedido é `discarded` com motivo, quem e quando.

### Como o adaptador reconstrói a raiz

`SupplierRequest` só nasce por `draft` e `rejected`. O adaptador remonta a linha pelos métodos da raiz, na ordem dos fatos: `rejected` (quando `status = discarded` e `subject = ''`) ou `draft` com o corpo atual; depois `recordIssuance` se há nota emitida; `markSendFailed(send_failure_reason)` se há motivo de falha; `markSent()` se `sent`; `discard(discard_reason)` se descartado por pessoa. `due_on` é recalculado de `drafted_on` pela raiz e deve bater com a coluna; diferença é dado corrompido, e o adaptador falha.

## Índices

| Índice | Tabela | Colunas | Serve | Sai sem travar escrita por |
|---|---|---|---|---|
| `outbox_supplier_emails_pkey` | `outbox_supplier_emails` | `(id)` | Q2, Q5 e todo `PATCH` por id | tabela nova: n/a |
| `outbox_supplier_emails_open_key` (único, parcial) | `outbox_supplier_emails` | `(invoice_access_key, request_type) where status in ('draft', 'sent', 'send_failed')` | AC-3, Q1 e Q1b: o filtro do `findOpen` e o do `listOpenKeys` repetem o predicado (`status=in.(draft,sent,send_failed)`), e o `listOpenKeys` ainda filtra `invoice_access_key` (a primeira coluna do índice), para o planejador poder usar o índice parcial ([Partial Indexes](https://www.postgresql.org/docs/current/indexes-partial.html)) | tabela nova: n/a |
| `outbox_supplier_emails_latest` | `outbox_supplier_emails` | `(invoice_access_key, request_type, id desc)` | Q6: o filtro por nota e tipo e a ordem por `id` decrescente com `limit 1` saem do índice | tabela nova: n/a |
| `outbox_supplier_emails_status` | `outbox_supplier_emails` | `(status, id desc)` | Q7: o filtro por estado e a ordem por `id` decrescente com `limit` saem do índice | tabela nova: n/a |
| `issued_return_notes_pkey` | `issued_return_notes` | `(id)` | a FK do pedido e a leitura da nota pelo número | tabela nova: n/a |
| `issued_return_notes_queue_id_key` (único) | `issued_return_notes` | `(queue_id)` | AC-2 e Q3: `issue` lê e grava por `queue_id`, e o `on_conflict=queue_id` do insert usa esta restrição | tabela nova: n/a |
| `kit_fornecedores_pkey` (existente) | `kit_fornecedores` | `(fornecedor_id)` | Q4: o e-mail do fornecedor da nota | já existe |
| `invoices_pkey` (existente) | `invoices` | `(access_key)` | Q4: a nota de origem | já existe |

`queue_id` referencia `outbox_return_notes` só por identidade, sem FK (PER-5): o `reconferir` (`api/src/ops/reconferir.ts`) apaga `outbox_return_notes`, e uma FK recusaria o apagar ou, em cascata, levaria junto a nota emitida e o pedido. Depois de um `reconferir`, as linhas de `issued_return_notes` e `outbox_supplier_emails` sobrevivem como referências órfãs, por desenho. As FKs de `supplier_id` (`kit_fornecedores`) e de `issued_return_note_id` seguem.

Sem índice nas FKs `supplier_id` e `issued_return_note_id` de `outbox_supplier_emails`: nenhuma consulta desta camada filtra ou junta por elas, e nada é apagado em cascata ([Foreign Keys](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK)). O índice entra com a consulta que o pedir (a lista do painel, nas rotas, ou a leitura da resposta, na #4).

`alter table kit_fornecedores add column email text` toma trava exclusiva por um instante numa tabela de dezenas de linhas, sem reescrita (coluna sem default). A coluna fica anulável: a migração roda antes da carga, e as linhas já carregadas não têm e-mail. `check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+$')`. O contrato do kit (`data/kit/contrato.json`) declara a coluna `email`, `text`, `nullable: true`, e a carga a preenche; `SourceInvoices.find` falha fechada quando o e-mail está nulo (nunca envia sem destinatário). Uma migração posterior, depois da primeira carga, pode pôr `not null`.

## Transações

Toda gravação é uma requisição PostgREST, uma transação, uma tabela. Nenhum adaptador abre transação (não há `BEGIN` na api).

| Caso de uso | Unidade de trabalho | Raiz alterada | Gravações dentro | Na falha | Efeito em outra raiz |
|---|---|---|---|---|---|
| Rascunho (`draftRequest`, tarefa do Cron e "refazer") | o `POST` do `create` | `SupplierRequest` | linha nova com `version = 1` e `history = [{action: 'drafted' ou 'rejected'}]` | violação do índice parcial: o PostgREST responde 409 com o código `23505` ([Errors](https://docs.postgrest.org/en/stable/references/errors.html)), e o adaptador devolve `{kind: 'conflict'}`; qualquer outro 409 (`23503`, FK) ou erro sobe | nenhum |
| Editar o corpo | o `PATCH` do `save` | `SupplierRequest` | corpo, `version + 1`, entrada de histórico | 0 linhas: versão velha ou trava de envio ativa: conflito | nenhum |
| Descartar | o `PATCH` do `save` com `discarded` | `SupplierRequest` | estado, motivo, `discarded_by/at`, `version + 1`, histórico | idem | nenhum |
| Enviar: trava | `PATCH` da trava (abaixo) | `SupplierRequest` | `send_claim`, `send_claimed_at`, `version + 1`, histórico `send_claimed` | 0 linhas: outro envio em curso ou versão velha: conflito, sem emitir nem enviar | nenhum |
| Enviar: emitir | `POST` em `issued_return_notes` | `IssuedReturnNote` | uma linha, `on_conflict=queue_id`, `ignore-duplicates`; vazio: lê por `queue_id` e devolve a mesma | erro sobe; antes do e-mail o envio solta a trava (`releaseSend`) e reenviar refaz; depois do e-mail a trava não é solta, para a lacuna do segundo e-mail não crescer | idempotente por `queue_id` |
| Enviar: registrar a emissão | `PATCH` do `save` (com a trava) | `SupplierRequest` | `issued_return_note_id`, `version + 1`, histórico | 0 linhas: perdeu a trava: para | nenhum |
| Enviar: mover a fila | `PATCH` existente com `status=eq.pendente` | entrada da fila | `emitida`, número, quem, quando | 0 linhas: conflito (já tratado no caso de uso) | idempotente pelo número |
| Enviar: marcar | `PATCH` do `save` (com a trava) | `SupplierRequest` | `sent` + carimbo + anexos, ou `send_failed` + motivo; limpa a trava; `version + 1`, histórico | 0 linhas: perdeu a trava | nenhum |

O envio toca três raízes em passos que confirmam sozinhos. O PostgREST não dá transação entre eles, e a #11 decidiu que o pedido é a raiz que manda e que reenviar conserta a falha no meio sem segunda nota (cabeçalho de `use-cases.ts`). TRX-3 pede o efeito em outra raiz como evento na mesma transação; aqui o efeito é um passo idempotente refeito pelo reenvio (ver "Conferência das regras").

### A guarda do envio concorrente

O buraco que a revisão achou: dois `send` do mesmo pedido, ao mesmo tempo, emitem a mesma nota (a emissão é idempotente), mas os dois mandam e-mail. A versão sozinha não fecha isso: quem lê o pedido depois da primeira gravação vê a versão nova e grava também. A guarda é uma **trava com prazo na linha**, tomada por um `PATCH` condicional antes de qualquer efeito:

```
PATCH outbox_supplier_emails
  ?id=eq.<id>&version=eq.<v>&status=in.(draft,send_failed)
  &or=(send_claim.is.null,send_claimed_at.lt.<agora - 5 min>)
body: { send_claim: <uuid novo>, send_claimed_at: <agora>, version: <v+1>, updated_at: <agora>, history: <lista + {send_claimed}> }
Prefer: return=representation
```

No Read Committed (o padrão), o segundo `UPDATE` na mesma linha espera o primeiro confirmar e reavalia o `WHERE` na versão nova da linha ([Transaction Isolation, 13.2.1](https://www.postgresql.org/docs/17/transaction-iso.html)): `version` e `send_claim` já não batem, e ele volta com 0 linhas. Só um envio segue. As gravações de quem tem a trava filtram `send_claim=eq.<uuid>` além de `version`, e a última (marcar `sent` ou `send_failed`) põe `send_claim` e `send_claimed_at` em nulo. Editar e descartar filtram `or=(send_claim.is.null,send_claimed_at.lt.<agora - 5 min>)`: ninguém edita o corpo de um e-mail que está saindo.

A trava expira em 5 minutos (assumido) para que um processo que morreu no meio não prenda o pedido para sempre; depois disso, o reenvio retoma. O resíduo: se o processo morrer **depois** do e-mail sair e antes de marcar `sent`, o reenvio depois do prazo manda um segundo e-mail. Fechar esse resíduo é chave de idempotência no provedor (o `send_claim` serve de chave), uma questão da camada do e-mail, em aberto.

O que muda nos casos de uso (#11) para isso existir, a ser feito por quem constrói a camada:

- `SupplierRequestStore` ganha `claimSend(id: number): Promise<{kind: 'claimed'} | {kind: 'conflict'}>` (o adaptador guarda a versão lida; o `uuid` NÃO fica no adaptador: `claimSend` o devolve, o envio o leva em `RequestChange.claim` de cada gravação sua e em `releaseSend(id, claim, by, at)`, e o adaptador filtra `send_claim=eq.<chave>` só quando ela é dada; edição e descarte não a levam e são recusados enquanto a trava vive, mesmo na mesma instância do adaptador), e `send` a chama logo depois de validar o texto, antes de `checkQueue`; conflito vira `{kind: 'conflict', reason: 'send_in_progress'}`.
- `save` passa a devolver `'ok' | 'stale'` (ou lançar um erro próprio), em vez de `void`: 0 linhas no `PATCH` não pode passar calado.
- `save` recebe quem fez em todo ato, não só no envio e no descarte: `editBody(id, body)` hoje não recebe quem editou, e o histórico (PER-3) pede quem. `RequestChange` ganha `by` e `at` obrigatórios, e o caso de uso passa o usuário e o relógio que já recebe.
- `SendStamp` leva os anexos (`filename`, `contentType`, id da nota) para a coluna `attachments` (AC-4).
- O `SupplierMailer` mock não grava na tabela do pedido: o registro do envio mock é a própria linha (`channel = 'mock'`, `provider_message_id` gerado), gravada pelo `save`. Uma raiz, um escritor.

### Ids e sequências

- `outbox_supplier_emails.id`: `generated always as identity`; o `POST` com `return=representation` devolve a linha com o id, e o adaptador monta a raiz com ele.
- `issued_return_notes.id`: `generated always as identity`, e é a sequência da nota (`ND-n`, número `n`). O `POST` com `on_conflict=queue_id` e `ignore-duplicates` consome um valor da sequência mesmo quando a devolução já tinha nota ([Sequence Manipulation Functions](https://www.postgresql.org/docs/17/functions-sequence.html): "an INSERT with an ON CONFLICT clause will compute the to-be-inserted tuple, including doing any required nextval calls, before detecting any conflict"). A numeração pode ter buracos. Para um mock isso basta; o adaptador lê por `queue_id` antes de inserir, e o buraco só aparece na corrida. Uma numeração sem buraco, como a NF-e de verdade pede, exigiria uma função no banco com trava, chamada por RPC, que o cliente não tem.

## Inquilino

Nenhum. `strategies.tenancy.strategy: none`. Todas as tabelas seguem a convenção do projeto: RLS ligado e nenhuma política; só a chave secreta (`service_role`, com `BYPASSRLS`) lê e grava.

## Conferência das regras

| Condição | Atendida por | Não atendida, e por quê |
|---|---|---|
| PER-1 | as três tabelas desta camada estão no registro | a #8 registrou `outbox_return_notes`, as tabelas do kit e as do domínio da conferência; as demais criadas antes da #12 seguem sem modo (em aberto) |
| PER-2 | `issued_return_notes`: o adaptador só faz `select` e `insert`; o `revoke` recusa o resto | nenhum |
| PER-3 | todo `PATCH` em `outbox_supplier_emails` acrescenta a entrada de histórico no mesmo `PATCH` | o `by` de editar só existe depois da mudança de porta acima |
| PER-4 | `version` em todo `PATCH`, filtrado por `version=eq.<lida>`; 0 linhas é recusa | o teste de versão velha roda contra o `FakePostgrest`, que precisa aplicar o filtro; não há banco de verdade |
| PER-5 | nenhum `delete` nas duas tabelas | nenhum |
| PER-6 | `issued_return_notes` não tem projeção: é lida linha a linha por chave | n/a |
| PER-7 | primeiro registro dos modos | n/a |
| PER-8 | `json-column` (PostgreSQL com `jsonb`) e `none` | a forma preferida seria a tabela filha; a coluna é a que cabe numa requisição só (acima) |
| TRX-1 | cada requisição PostgREST é uma transação; entidade, histórico e versão são um `PATCH` | nenhum |
| TRX-2 | nenhum adaptador emite `BEGIN`/`COMMIT` | nenhum |
| TRX-3 | cada gravação toca uma raiz | o envio afeta a fila e a nota emitida sem evento na mesma transação: são passos idempotentes refeitos pelo reenvio, a decisão da #11; registrar como ADR (em aberto) |
| TRX-4 | o PostgREST confirma ou desfaz cada requisição | nenhum |
| IDX-1 | Q1 a Q7 têm índice acima | sem banco de verdade, nenhum teste lê o plano; o detector seria um teste de integração que roda `EXPLAIN` no Q1 com linhas semeadas |
| IDX-2 | cada índice novo tem a consulta ao lado | nenhum |
| IDX-3 | n/a (relacional) | |
| IDX-4 | só tabelas novas recebem índice | nenhum |
| MT-1 a MT-5 | sem inquilino | n/a |

## Testes que a camada traz (FakePostgrest + texto da migração)

- Texto da migração: o índice único parcial com o predicado exato; `unique (queue_id)`; o `revoke update, delete, truncate` em `issued_return_notes`; os `check` `-- ADR-002`; RLS ligado nas tabelas novas; `version`, `history`, `send_claim`.
- `create` com um pedido aberto da mesma nota e tipo devolve `conflict` (o fake devolve 409 `23505`); com o existente descartado, entra.
- `issue` duas vezes com a mesma devolução devolve a mesma nota, com o mesmo número e a mesma chave.
- Dois `claimSend` na mesma versão: um ganha, o outro é conflito; uma trava vencida é retomada.
- `save` com versão velha volta `stale`; duas edições geram duas entradas de histórico com versões seguidas.
- O `FakePostgrest` hoje entende só `eq.`, `in.` e `not.is.null` (`api/test/support/fake-postgrest.ts`); a camada estende com `is.null`, `lt.`, `or=(...)` e o 409 com código `23505`.

## Em aberto

- Mudanças de porta em `api/src/supplier/ports.ts` e `use-cases.ts` (#11): `claimSend`, `save` que diz `stale`, `by` em todo `save`, anexos no `SendStamp`. Quem decide: o tech lead da #2 (Athena), ao planejar a camada; quem faz: o construtor da camada do backend.
- Prazo da trava do envio: 5 minutos assumidos; o tempo máximo do envio de e-mail (Resend) não está dito. Quem responde: o construtor da camada do e-mail.
- Chave de idempotência no provedor de e-mail para fechar o resíduo depois da trava vencida. Quem responde: a camada do e-mail.
- ADR a registrar: "a unidade de trabalho é uma requisição PostgREST; o histórico mora em `jsonb` na linha; o efeito em outra raiz é passo idempotente". Alternativas: funções no banco chamadas por RPC (uma transação por caso de uso), conexão direta ao Postgres. Quem aprova: o mantenedor.
- Registrar as tabelas criadas antes da #12 que a #8 não registrou (`titles`, `outbox_dock_actions`, `outbox_registry_corrections`, `outbox_store_actions`, `claude_suggestions`, `exceptions`, `automation_runs`) com seus modos. Fechado pelo registro da #8: `outbox_return_notes` (upsert-with-history, histórico `in-row-transition`, versão em `status`), que esta camada escreve na transição `pendente` → `emitida`. Quem decide: o dono de cada tabela.
- Caminho de apagamento (LGPD) para `sent_by` e `discarded_by`, que identificam pessoas: não registrado no projeto. Quem decide: o mantenedor.
- Nenhum teste lê plano nem catálogo (não há banco de verdade nos testes): IDX-1 e a conferência do `revoke` ficam sem detector.
