# Desenho da persistência: leitura da resposta do fornecedor (#157)

Issue: #157 (história #157, AC-1 a AC-7; origem formacao-fde-solucao-case#157). Banco: PostgreSQL 17 no Supabase (`supabase/config.toml`, `major_version = 17`), acessado só pelo PostgREST com a chave secreta. Registro: `supabase/persistence-modes.yaml`. Migração desta camada: `supabase/migrations/20261117170000_inbox_supplier_messages.sql`. O carimbo vem depois de tudo no `main` (`20261116100000`), da #156 (`20261116120000`) e de todo carimbo já usado em outro branch (`20261116170000` da PR Djegao/grupo-5-slucao#40, `20261117160000`).

**Em uma frase:** a caixa de entrada mock é uma tabela nova (`inbox_supplier_messages`). As leituras são fatos numa tabela append-only nova (`supplier_reply_readings`), e a leitura atual é derivada pela ordem das mensagens. A cobrança mora em colunas novas de `outbox_supplier_emails`, a tabela da #156, sob a versão e o histórico que a #156 registrou. Nenhuma tabela nova representa o pedido.

## Entradas

| Entrada | Valor | Fonte |
|---|---|---|
| Raízes | o pedido ao fornecedor `SupplierRequest` (#156, `outbox_supplier_emails`), visto pela leitura como `ReplyRequest` (leitura e cobrança); a mensagem da caixa de entrada (`InboxMessage`); a leitura `SupplierReading` (valor: o domínio a valida e não a muda) | `api/src/domain/supplier-reply.ts`, `api/src/supplier/reply-ports.ts` |
| Consultas | **QI1** `inbox.listPending`: mensagens `pending`, da mais antiga para a mais nova. **QI2** `inbox.get(id)`: a mensagem, se ainda `pending`. **QI3** `markRead`/`markError`: transição por id. **QR1** `requests.listSent`: todo pedido `sent` com a leitura atual e o estado da cobrança, de onde saem a varredura (que monta a cobrança, #157), o `pending()` da leitura e a lista com as contagens (`GET /api/supplier-requests?status=`). **QR1b**: o número da nota de origem dos pedidos de QR1. **QR2** `requests.get(id)`: o pedido com a leitura atual. **QR3** `recordReading` com mensagem. **QR4** `recordReading` da varredura (`messageId` nulo). **QR5** o "superseded": existe leitura que vence a recém-gravada? **QF1** a **QF4**: rascunho da cobrança, reivindicação, falha e envio (e, desde a #157, **QF1b**: a edição do texto do rascunho) | `reply-ports.ts`, `reply-use-cases.ts`, `reply-task.ts`, #157 (a cobrança, #157: montada pela regra na varredura, sem tarefa do Claude) |
| Inquilino | nenhum (`strategies.tenancy.strategy: none`) | registro |
| Números assumidos | pedidos enviados: abaixo de 1000, uma página (`max_rows = 1000`, `supabase/config.toml`), não informado; mensagens por pedido: poucas (o pedido, um pedido de informação, a resposta), não informado; leituras por pedido: no máximo as mensagens mais uma (`no_reply`); a caixa mock recebe as quatro respostas do script (#157) | não informado pela issue |

## A decisão: onde moram a leitura e a cobrança

O plano aprovado punha as colunas da leitura (`reply_outcome`, `fulfilled_asks`, `supplier_document`, `summary`, `next_step`, `follow_up_draft`, `injection_flag`, `read_at`) na linha do pedido. Este desenho separa as duas metades. **A leitura** vai para uma tabela própria, append-only, ligada ao pedido. **A cobrança** (`follow_up_*`, que inclui o `follow_up_draft` do plano) fica na linha do pedido.

### Por que a leitura sai da linha do pedido

1. **A leitura é um fato, não uma entidade que alguém edita.** Ela diz que a mensagem M foi lida assim, ou que o prazo venceu sem resposta. Nenhuma pessoa a altera. Uma leitura mais nova não corrige a anterior: vem depois dela. `docs/entity-history.md` do plugin manda gravar uma resposta como fato, em append-only, e quando há dúvida a preferência também é append-only. O erro que ele descreve é o do plano: chamar de upsert a sequência de leituras que troca o valor de uma coluna.
2. **Na linha do pedido, a regra "a mensagem mais nova vence" não fica numa requisição só.** A #156 registrou que todo `PATCH` em `outbox_supplier_emails` filtra `version=eq.<lida>` e acrescenta a entrada de histórico montada no cliente. O PostgREST não deixa escrever `history = history || $entrada` num `PATCH`. A gravação condicional ficaria então `id & version=eq.v & or=(reading_message_id.is.null,reading_message_id.lte.M)`, e 0 linhas teria duas causas possíveis: a versão andou (outra leitura ou a cobrança gravou) ou a leitura guardada é mais nova. Separar as duas pede uma releitura e uma nova tentativa, ou seja, ler e depois gravar, que é o que a docstring de `recordReading` proíbe. Gravar sem o filtro de versão perde entradas de histórico (PER-4).
3. **Em append-only, a regra vira uma gravação e uma ordem.** `recordReading` é um `POST` (uma requisição, uma transação: [PostgREST, Transactions](https://docs.postgrest.org/en/stable/references/transactions.html), como já cita a nota da #156). A leitura atual é a de maior `message_id`. A leitura da varredura (`message_id` nulo) só vale enquanto não há leitura de mensagem. Dois leitores ao mesmo tempo não brigam, porque nenhum grava por cima do outro. A leitura antiga que chega depois da nova (o runner roda as chaves novas antes das retentativas) é gravada como fato e perde pela ordem. Não há corrida a guardar.
4. **Nada se perde, e cada leitura se rastreia até a mensagem.** Na coluna, a leitura trocada só sobraria dentro do JSON do histórico. Na tabela, cada leitura aponta para a mensagem que a gerou, e uma restrição garante que a mensagem é do mesmo pedido.

O custo: a lista e o `get` precisam derivar a leitura atual. Isso cabe na mesma requisição de QR1/QR2, pelo embedding do PostgREST (abaixo), e uma função pura do adaptador escolhe a linha (a projeção, com o teste que a remonta).

### Por que a cobrança fica na linha do pedido

- Ela é o segundo e-mail do mesmo pedido, com o mesmo ciclo do primeiro que a #156 já guarda na linha: rascunho do agente, reivindicação do envio, carimbo ou falha. A transição não é única (falha, nova reivindicação, envio), então não cabe no `in-row-transition`. Ela precisa de versão e histórico, e a linha da #156 já os tem.
- **Sem disputa com a #156.** Depois de `sent`, a #156 não grava mais a linha: `markSent` parte de `draft` e `send_failed`, `discard` e `editBody` partem de `draft` (`api/src/domain/supplier-request.ts`). Num pedido enviado, as únicas gravações são as da cobrança, que vêm uma depois da outra (o rascunho exige `follow_up_draft` nulo; a reivindicação exige o rascunho). O filtro de versão quase nunca volta 0 por causa de outro escritor.
- A reivindicação é um `PATCH` condicional na própria linha, a forma que a #156 já usa para `send_claim`.
- Uma tabela à parte para a cobrança seria outra entidade com outra versão e outro histórico. Isso não traz nada que a linha não dê e abre um segundo jeito de guardar o mesmo ciclo.

O que a cobrança perde por não ver a leitura na mesma linha: a reivindicação não consegue filtrar "a leitura atual ainda é `no_reply`". O caso de uso confere isso no `get` antes de reivindicar. Uma resposta lida entre esse `get` e a reivindicação deixaria a cobrança sair. Com a leitura na linha, o filtro fecharia só essa janela. A janela maior continua aberta nos dois desenhos: a resposta que chegou à caixa e ainda não foi lida pelo Cron. Ver "Em aberto".

## Tabelas

| Tabela | Modo | Por quê: fato ou entidade editada | Histórico: forma e lugar | Versão | Inquilino |
|---|---|---|---|---|---|
| `inbox_supplier_messages` (nova) | upsert-with-history, `in-row-transition` | a mensagem (remetente, texto, anexos, chegada) é um fato que nunca muda; `read_status` sai de `pending` uma vez, para `ok` ou `error` | na própria linha: quem (`read_status_by`, a tarefa da leitura), quando (`read_status_at`) e, no erro, o motivo fechado (`read_error`); o estado anterior é sempre `pending` | `read_status` (o `PATCH` filtra `read_status=eq.pending`) | nenhum |
| `supplier_reply_readings` (nova) | append-only | fato: a mensagem M foi lida assim, ou o prazo venceu sem resposta | nenhum: o log é a tabela; `UPDATE`/`DELETE` recusados por grant | n/a | nenhum |
| `outbox_supplier_emails` (#156, só colunas `follow_up_*`) | upsert-with-history (mantido) | a cobrança é editada pelo ciclo do envio | `history jsonb` da #156; cada gravação da cobrança acrescenta uma entrada no mesmo `PATCH` | `version` (#156) | nenhum |

### `inbox_supplier_messages`: colunas

- `id bigint generated always as identity`, chave primária. É o `messageId` das portas. A ordem dos ids é a ordem de inserção, e a regra "a mensagem mais nova vence" se apoia nela. O script e um webhook futuro inserem na ordem de chegada. Duas inserções concorrentes podem confirmar fora da ordem dos ids, o que não acontece com um escritor só (ver "Em aberto").
- `request_id bigint not null`, FK `outbox_supplier_emails(id)` (`inbox_supplier_messages_request_fkey`).
- `source_message_id text not null`, `unique` (`inbox_supplier_messages_source_message_id_key`). É a identidade da mensagem na origem: no script, uma chave fixa por exemplo e pedido; no webhook de entrada, o Message-ID. Ela torna o script reexecutável (`on_conflict=source_message_id`, `ignore-duplicates`) sem duplicar a caixa.
- `from_address text not null`. `from` é palavra reservada do SQL e pediria aspas em todo filtro, como `to` virou `recipient` na #156.
- `body text not null`: o texto do fornecedor. É dado, nunca instrução, e só o prompt o lê, escapado.
- `attachments_meta jsonb not null default '[]'`, `check (jsonb_typeof(attachments_meta) = 'array')`. Cada item é `{filename, content_type, size_bytes}`. O conteúdo não é guardado (#157: "anexo, se houver, como metadado").
- `received_at timestamptz not null default now()`: quando chegou; o script grava a hora que quiser.
- `read_status text not null default 'pending'`, `check (read_status in ('pending', 'ok', 'error'))` `-- ADR-002`.
- `read_error text`, `check (read_error is null or read_error ~ '^[a-z_]+: [a-z_]+$')`. O banco só aceita o motivo fechado `<motivo>: <campo>` que `reply-task.ts` monta. O texto do modelo ou do fornecedor não cabe nesse formato.
- `read_status_at timestamptz`: quando saiu de `pending` (ADR-005).
- `read_status_by text`: quem fez a transição (PER-3). A leitura não é ato humano: grava o nome da tarefa (`SUPPLIER_READING_TASK`, `reply-task.ts`), nunca uma pessoa. Nulo só enquanto `pending`.
- `created_at timestamptz not null default now()` (ADR-005).
- `unique (id, request_id)` (`inbox_supplier_messages_id_request_key`): o alvo da FK composta das leituras.
- Coerência: `(read_status = 'pending') = (read_status_at is null)`; `(read_status = 'pending') = (read_status_by is null)`; `(read_status = 'error') = (read_error is not null)`.
- Recusa: `revoke update, delete, truncate on public.inbox_supplier_messages from anon, authenticated, service_role;` e depois `grant update (read_status, read_error, read_status_at, read_status_by) on public.inbox_supplier_messages to service_role;`. O privilégio de coluna basta para o `PATCH` da transição. O privilégio de tabela vem revogado antes, porque "the table-level grant is unaffected by a column-level operation" ([GRANT, Notes](https://www.postgresql.org/docs/17/sql-grant.html)). A `service_role` tem `BYPASSRLS`, então quem recusa é o grant, como em `issued_return_notes` (#156).

### `supplier_reply_readings`: colunas

- `id bigint generated always as identity`, chave primária.
- `request_id bigint not null`, FK `outbox_supplier_emails(id)` (`supplier_reply_readings_request_fkey`).
- `message_id bigint`, `unique` (`supplier_reply_readings_message_key`): uma leitura por mensagem. Ela é o alvo do `on_conflict` de QR3. Nulo é a leitura da varredura.
- FK composta `(message_id, request_id)` → `inbox_supplier_messages (id, request_id)` (`supplier_reply_readings_message_fkey`): a mensagem é do mesmo pedido. Com `message_id` nulo, a FK não é conferida: "a referencing row need not satisfy the foreign key constraint if any of its referencing columns are null" ([Foreign Keys](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-FK)). A mesma página exige chave primária ou restrição única no alvo, e daí vem o `unique (id, request_id)` da caixa.
- `reply_outcome text not null`, `check (reply_outcome in ('fulfilled', 'partially_fulfilled', 'refused', 'needs_information', 'no_reply'))` `-- ADR-002`.
- `fulfilled_asks jsonb not null`, `check (jsonb_typeof(fulfilled_asks) = 'array')`.
- `supplier_document text`; `summary text not null`, `check (btrim(summary) <> '')`; `injection_flag text`.
- `next_step text not null`, `check (next_step in ('close', 'confirm_document', 'answer_supplier', 'follow_up'))` `-- ADR-002`.
- `read_at timestamptz not null default now()`: o carimbo de criação da linha (ADR-005). Numa linha append-only, criar é ler, e o nome é o do plano.
- Regras do domínio repetidas no banco, para a linha que fugir do domínio não entrar:
  - `(reply_outcome = 'no_reply') = (message_id is null)`: `no_reply` só vem da varredura, e `validateReading` recusa `no_reply` para uma resposta.
  - `reply_outcome <> 'no_reply' or next_step = 'follow_up'`.
  - `reply_outcome <> 'fulfilled' or supplier_document is null or next_step = 'confirm_document'` (#157, `guardNextStep`).
  - `next_step <> 'close' or reply_outcome = 'fulfilled'` (`guardNextStep`).
  - Não copiar a regra da PR Djegao/grupo-5-slucao#40 (`outcome <> 'fulfilled' or next_step = 'confirm_document'`). Ela impede `fulfilled` sem documento de fechar, e o domínio daqui permite.
- Nenhuma coluna aponta para proposta, título ou valor em risco (#157).
- Recusa: `revoke update, delete, truncate on public.supplier_reply_readings from anon, authenticated, service_role;` ([Privileges](https://www.postgresql.org/docs/current/ddl-priv.html)).

### `outbox_supplier_emails`: colunas que a #157 acrescenta

Todas anuláveis e sem default, num único `alter table ... add column ..., add constraint ...`:

- `follow_up_draft jsonb`, `check (follow_up_draft is null or jsonb_typeof(follow_up_draft) = 'object')`: o `SupplierRequestText` `{subject, body, asks}` na forma com `{{chave}}`, como o pedido guarda.
- `follow_up_rejection text`, `check (follow_up_rejection is null or follow_up_rejection ~ '^[a-z_]+: [a-z_]+$')`: o motivo fechado da recusa do texto (#157).
- `follow_up_claimed_at timestamptz`: a reivindicação do envio. Tem o prazo da #156 (`LEASE_MS`, 5 minutos, o mesmo do `send_claim`): o filtro do `PATCH` da reivindicação aceita a linha sem reivindicação ou com uma mais velha que o prazo (`follow_up_claimed_at.lt.<agora - prazo>`), e a falha (`recordFollowUpFailure`) também a solta. Depois do envio ela continua gravada e nunca vence, porque o filtro exige `follow_up_sent_at is null`: é ela, com o carimbo, que impede um segundo e-mail. **Risco aceito:** se o processo que perdeu a reivindicação chegou a enviar e morreu antes de gravar o carimbo, a retomada envia um segundo e-mail; o carimbo dele é recusado (ver a ficha).
- `follow_up_claim uuid`: a ficha da reivindicação, como o `send_claim` da #156. `claimFollowUpSend` a gera (`crypto.randomUUID()`), grava junto de `follow_up_claimed_at` e a devolve a quem ganhou. `recordFollowUpFailure` e `recordFollowUpSent` recebem a ficha e filtram o `PATCH` por `follow_up_claim=eq.<ficha>`: quem perdeu a reivindicação no prazo recebe 0 linhas e não solta nem carimba a de outro. A falha anula as duas colunas; o carimbo mantém as duas. A ficha não vai ao histórico, à leitura do pedido (`REQUEST_SELECT` não a pede) nem ao log.
- `follow_up_sent_by text`, `follow_up_sent_at timestamptz`, `follow_up_channel text check (follow_up_channel in ('mock', 'resend'))` `-- ADR-002`, `follow_up_provider_message_id text`: o carimbo do envio (ADR-005, ato humano).
- `follow_up_failure text`, `check (follow_up_failure is null or follow_up_failure ~ '^[a-z][a-z0-9_]{0,39}$')`: o mesmo `SHORT_REASON` de `reply-use-cases.ts`. O texto do provedor não cabe nesse formato.
- Coerência:
  - `(follow_up_sent_at is null) = (follow_up_sent_by is null) and (follow_up_sent_at is null) = (follow_up_channel is null) and (follow_up_sent_at is null) = (follow_up_provider_message_id is null)`.
  - `follow_up_draft is null or follow_up_rejection is null`: rascunho ou recusa, nunca os dois.
  - `follow_up_claimed_at is null or follow_up_draft is not null`.
  - `(follow_up_claim is null) = (follow_up_claimed_at is null)`: a ficha anda junto com o prazo.
  - `follow_up_sent_at is null or follow_up_claimed_at is not null`: o envio mantém a reivindicação.
  - `follow_up_sent_at is null or follow_up_failure is null`: o envio limpa a falha.
  - `status = 'sent' or (follow_up_draft is null and follow_up_rejection is null and follow_up_claimed_at is null and follow_up_claim is null and follow_up_sent_at is null and follow_up_failure is null)`: só pedido enviado tem cobrança.
- A migração: `ADD COLUMN` sem default não reescreve a tabela ("If no DEFAULT is specified, NULL is used. In neither case is a rewrite of the table required", [ALTER TABLE, Notes](https://www.postgresql.org/docs/17/sql-altertable.html)). O comando toma `ACCESS EXCLUSIVE`, e cada `CHECK` novo varre a tabela para validar sob a mesma trava. A tabela é a da #156, ainda fora do `main`, com poucas linhas. Todas as colunas novas nascem nulas, e toda regra acima vale para elas. Numa tabela grande, o caminho seria `NOT VALID` e depois `VALIDATE CONSTRAINT`, que toma só `SHARE UPDATE EXCLUSIVE` (mesma página).

#### Como a cobrança segue a disciplina da #156

Cada gravação da cobrança faz um `GET` da linha, para ler `version` e `history`, e depois um único `PATCH` guardado: `id=eq.<id>&version=eq.<v>&<guarda da transição>`. O corpo leva as colunas da cobrança, `version: v+1`, `updated_at` e `history` com uma entrada a mais. A entrada é `{version, at, by, action, state, follow_up}`, com estes campos:

- `action`: um de `follow_up_drafted`, `follow_up_rejected`, `follow_up_claimed`, `follow_up_failed`, `follow_up_sent`, `follow_up_edited`; e, da #157, `document_confirmed` (abaixo).
- `state`: o `state` da última entrada, copiado sem mudar. A cobrança não muda o estado da #156.
- `follow_up`: o estado da cobrança depois da gravação.
- `by`: o nome da varredura do prazo (`supplier-overdue-sweep`, #157) quando quem grava é a regra; o usuário quando é uma pessoa (ver as mudanças de porta). Até a #157 era o nome da tarefa do Claude (`supplier-follow-up-draft`), que saiu do Cron; as linhas antigas guardam esse nome.

O guard de forma da #156 (`history: arrayOf(isUnknown)`) aceita a chave a mais. O construtor confere que o `select` e o `shaped` do adaptador da #156 não recusam as colunas novas.

### A confirmação do documento (#157): uma entrada do histórico, sem migração

A pessoa confirma o documento que o fornecedor citou na leitura (`fulfilled`, `supplier_document`, próximo passo `confirm_document`). A confirmação é um fato com quem e quando (ADR-005), e ela cabe no que já existe: **uma entrada do `history jsonb` da linha do pedido**, com `action: 'document_confirmed'`, `document` (o documento confirmado), `by` (o e-mail do Access), `at`, e o `state` e o `follow_up` das outras entradas. Nenhuma coluna nova, nenhuma tabela, nenhuma migração: o modo de `outbox_supplier_emails` (`upsert-with-history`, histórico `json-column`, versão em `version`) já diz onde o histórico mora, e a entrada é a que o histórico foi desenhado para guardar.

- **Gravação (QF5).** `confirmDocument` lê a linha (`GET`, para `version` e `history`) e faz um único `PATCH` guardado: `id=eq.<id>&version=eq.<v>&status=eq.sent`, com o corpo só em `version: v+1`, `updated_at` e `history` com a entrada a mais. Nenhuma coluna do pedido muda (#157), e nenhuma outra tabela é tocada. Se o histórico lido já tem a confirmação do mesmo documento, volta `already_confirmed` sem gravar. Com 0 linhas, relê: o documento confirmado agora é `already_confirmed` (a outra chamada ganhou), senão a linha andou por outra gravação e volta `stale`. Duas chamadas ao mesmo tempo na mesma versão: um `PATCH` pega a linha, o outro, 0 linhas; um 200 e um 409.
- **Leitura.** O `select` do pedido pede `history`; `confirmationsOf` (`supabase-reply-request-row.ts`) tira as entradas `document_confirmed` bem formadas, e a regra do domínio (`confirmationOf`) escolhe a mais recente **do documento da leitura atual**. A entrada fora do formato é ignorada, não lançada.
- **Uma leitura nova.** A confirmação é do documento, não da leitura: uma leitura nova que cita o mesmo documento mantém a confirmação, e uma que cita outro documento (ou deixa de ser `fulfilled` com `confirm_document`) deixa a velha no histórico e o pedido volta a `needs_you`, pedindo outra. O histórico nunca perde a entrada antiga.
- **Custo.** O histórico de um pedido é curto e já era lido com a linha nas gravações; agora também vai na lista de leitura (`listSent`). Se um dia a lista pesar, a confirmação ganha coluna própria (`document_confirmed_*`) numa migração; a regra e a API não mudam.

## Leituras e gravações dos adaptadores

**QR1, a lista e tudo o que parte de `listSent` (uma requisição, mais QR1b):**

```
GET outbox_supplier_emails
  ?select=id,invoice_access_key,request_type,recipient,subject,asks,note,due_on,status,supplier_id,
          follow_up_draft,follow_up_rejection,follow_up_claimed_at,follow_up_sent_by,follow_up_sent_at,
          follow_up_channel,follow_up_provider_message_id,follow_up_failure,
          kit_fornecedores(razao_social),
          supplier_reply_readings!supplier_reply_readings_request_fkey(message_id,reply_outcome,fulfilled_asks,
            supplier_document,summary,next_step,injection_flag,read_at)
  &status=eq.sent
  &supplier_reply_readings.order=message_id.desc.nullslast
  &order=id
```

O embedding segue as FKs. A ordem do recurso embutido usa a sintaxe de "Embedded Filters" (`actors.order=...`), e `nullslast` vem de "Ordering" ([Resource Embedding](https://docs.postgrest.org/en/stable/references/api/resource_embedding.html), [Tables and Views](https://docs.postgrest.org/en/stable/references/api/tables_views.html)). O nome da FK depois de `!` desfaz a ambiguidade, se o PostgREST vir mais de um caminho (PGRST201, mesma página). O adaptador não depende da ordem nem de um `limit=1` no embutido. A função pura `currentReading(rows)` aplica a regra: a leitura de maior `message_id`, ou a da varredura se não há leitura de mensagem. Essa função é a projeção (PER-6). `kit_fornecedores(razao_social)` dá o `supplierName` pela FK `outbox_supplier_emails_supplier_fkey`.

**QR1b.** `outbox_supplier_emails` não tem FK para `invoices`, então o `invoiceNumber` sai de `GET invoices?select=access_key,number&access_key=in.(<chaves de QR1>)`, pela `invoices_pkey`. Para menos de 1000 pedidos, a URL cresce com as chaves (44 algarismos cada). O limite de URL já ficou em aberto na #156. A alternativa sem `in.(...)` é uma FK `outbox_supplier_emails.invoice_access_key → invoices(access_key)`, que mudaria a tabela da #156 e pediria `invoices` presente para todo pedido: fica para o mantenedor.

**QR2** `get(id)`: o mesmo `select` com `id=eq.<id>` (sem filtro de status), e QR1b com uma chave.

**QR3** `recordReading(id, reading, M)`: `POST supplier_reply_readings?on_conflict=message_id` com `Prefer: return=representation,resolution=ignore-duplicates` ([Tables and Views, upsert e on_conflict](https://docs.postgrest.org/en/stable/references/api/tables_views.html)). Se a resposta vier vazia, a mensagem já tinha leitura (a retentativa depois de `markRead` falhar): a primeira leitura fica, e o resultado segue para QR5.

**QR4** `recordReading(id, overdue, null)`: `POST` simples, sem `on_conflict`. O índice único parcial `supplier_reply_readings_one_no_reply` faz a segunda varredura falhar com 409 `23505`, que o adaptador lê como "já havia `no_reply`" e devolve `superseded`. Não há `on_conflict` para esse índice porque o PostgREST não passa o predicado, e o PostgreSQL só escolhe um índice único parcial como árbitro quando o predicado é dado: o `index_predicate` é "used to allow inference of partial unique indexes" ([INSERT, ON CONFLICT](https://www.postgresql.org/docs/17/sql-insert.html)). É o mesmo caminho do `create` da #156.

**QR5** "superseded": `GET supplier_reply_readings?select=id&request_id=eq.<id>&message_id=gt.<M>&limit=1`, ou, na varredura, `message_id=not.is.null`. Uma linha encontrada dá `superseded`; nenhuma dá `recorded`. Esta leitura só informa a saída da tarefa e não decide nada. Qual leitura vale é a projeção, que não tem corrida. **O sentido de `superseded` muda um pouco:** a leitura foi gravada no log mas não é a atual. A docstring de `ReadingRecorded` ("não foi gravada") passa a dizer isso (ver "Mudanças de porta").

**QI1** `listPending`: `GET inbox_supplier_messages?select=id,request_id,body&read_status=eq.pending&order=id`. **QI2** `get(id)`: `id=eq.<id>&read_status=eq.pending`. **QI3**: `PATCH ?id=eq.<id>&read_status=eq.pending` com `{read_status: 'ok', read_status_at}` ou `{read_status: 'error', read_error, read_status_at}`. Com 0 linhas, o adaptador relê. Se a mensagem já está no mesmo estado final, `markRead`/`markError` é idempotente e volta. Com outro estado, lança.

**QF1** `saveFollowUpDraft`: guarda `status=eq.sent&follow_up_draft=is.null&follow_up_rejection=is.null`. Com 0 linhas, o adaptador relê. Se já há rascunho ou recusa, não grava e volta (#157: a cobrança não se repete). Se a versão andou por outro motivo, lança. Desde a #157 o rascunho (`jsonb`) leva também `dueOn`, o novo prazo da cobrança (AAAA-MM-DD), sem coluna nova; o rascunho do Claude, de antes, não o tem. Nada mais grava `follow_up_rejection`: as recusas já gravadas seguem lidas.

**QF1b** `editFollowUpDraft` (#157): lê a linha, troca o texto do rascunho (mantém o `dueOn`) num `PATCH` guardado pela versão lida e pela mesma guarda da reivindicação (`status=eq.sent&follow_up_draft=not.is.null&follow_up_sent_at=is.null&or=(follow_up_claimed_at.is.null,follow_up_claimed_at.lt.<agora - LEASE_MS>)`), com a entrada `follow_up_edited` e o e-mail de quem editou em `by`. Corpo: o texto novo e `follow_up_claimed_at`/`follow_up_claim` nulos: a edição depois da reivindicação vencida a solta, e o antigo detentor, se voltar, recebe `lost` no carimbo. Com 0 linhas relê: carimbado é `already_sent`, reivindicação de pé (há menos que `LEASE_MS`) é `send_in_progress`, o resto é `stale`.

**QF5** `confirmDocument` (#157): `GET` da linha, depois um `PATCH` guardado por `version=eq.<lida>&status=eq.sent` com a entrada `document_confirmed` no `history`; ver "A confirmação do documento".

**QF2** `claimFollowUpSend`: guarda `status=eq.sent&follow_up_draft=not.is.null&follow_up_sent_at=is.null&or=(follow_up_claimed_at.is.null,follow_up_claimed_at.lt.<agora - LEASE_MS>)` (o prazo da #156: a reivindicação vencida é retomada; ver o risco aceito nas colunas). Corpo: `follow_up_claimed_at`, a versão nova e a entrada `follow_up_claimed`. Corpo também: a ficha nova (`follow_up_claim`). Uma linha devolvida dá a ficha (`won`); 0 linhas dá `taken` (outro envio reivindicado ou carimbado, ou não há o que enviar) ou `stale` (#157: a versão andou numa edição no meio). A reivindicação recebe o texto que o envio leu: se a linha lida já tem outro, volta `stale` sem gravar, e o `PATCH` pela versão lida fecha a janela entre a leitura e a gravação, de modo que o envio nunca manda um texto que a pessoa já trocou. No Read Committed, o segundo `UPDATE` da mesma linha espera o primeiro confirmar e reavalia o `WHERE` na versão nova ([Transaction Isolation, 13.2.1](https://www.postgresql.org/docs/17/transaction-iso.html), como na #156). Só um ganha.

**QF3** `recordFollowUpFailure(id, claim, reason, by)`: relê a linha; se `follow_up_claim` não é a `claim` recebida, volta `lost` sem gravar. Senão, `PATCH` com a guarda `follow_up_claim=eq.<claim>&follow_up_sent_at=is.null` (mais a versão lida). Corpo: `follow_up_claimed_at: null`, `follow_up_claim: null`, `follow_up_failure`, versão e histórico. **QF4** `recordFollowUpSent(id, claim, stamp)`: a mesma leitura e a mesma guarda. Corpo: o carimbo, `follow_up_failure: null`, a reivindicação e a ficha mantidas, versão e histórico.

**Quando a ficha não é a do detentor.** Em QF3 e QF4, 0 linhas no `PATCH` faz o adaptador reler: se a ficha deixou de ser a do chamador, o resultado é `lost` (a reivindicação venceu e outro a retomou, ou foi solta); se ainda é a dele, o dado está fora do esperado (a versão andou com a reivindicação dele de pé) e a gravação lança. A ficha é o que fecha a cena "A reivindica e estagna além do prazo; B retoma e envia; A grava falha, soltando a reivindicação de B, e um terceiro envia de novo; o carimbo de B é recusado": a falha e o carimbo de A voltam `lost` e a linha continua como B a deixou. O caso de uso trata `lost` como `conflict`/`send_in_progress` e registra no log só a operação e o pedido. Se QF4 lançar (o banco), a reivindicação fica presa e não sai segundo e-mail, como o caso de uso quer.

**Script de exemplo (#157).** Ele faz `POST inbox_supplier_messages?on_conflict=source_message_id` com `ignore-duplicates` e quatro linhas (atendeu, recusou, pediu informação, ordem escondida), ligadas a pedidos `sent` que já existem. Não grava leitura nem toca o pedido.

## Índices

| Índice | Tabela | Colunas | Serve | Sai sem travar escrita por |
|---|---|---|---|---|
| `inbox_supplier_messages_pkey` | `inbox_supplier_messages` | `(id)` | QI2, QI3 | tabela nova: n/a |
| `inbox_supplier_messages_pending_idx` (parcial) | `inbox_supplier_messages` | `(id) where read_status = 'pending'` | QI1: o filtro repete o predicado (`read_status=eq.pending`) e a ordem é `id` ([Partial Indexes](https://www.postgresql.org/docs/current/indexes-partial.html)); as pendentes são a fração pequena da caixa | tabela nova: n/a |
| `inbox_supplier_messages_source_message_id_key` (único) | `inbox_supplier_messages` | `(source_message_id)` | o `on_conflict` do script (e do webhook futuro) | tabela nova: n/a |
| `inbox_supplier_messages_id_request_key` (único) | `inbox_supplier_messages` | `(id, request_id)` | alvo da FK composta das leituras (exigência da FK, [Foreign Keys](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-FK)) | tabela nova: n/a |
| `supplier_reply_readings_pkey` | `supplier_reply_readings` | `(id)` | identidade da linha; nenhuma consulta lê por ela | tabela nova: n/a |
| `supplier_reply_readings_message_key` (único) | `supplier_reply_readings` | `(message_id)` | QR3: o `on_conflict=message_id` (uma leitura por mensagem) | tabela nova: n/a |
| `supplier_reply_readings_one_no_reply` (único, parcial) | `supplier_reply_readings` | `(request_id) where message_id is null` | QR4: um `no_reply` por pedido (#157) | tabela nova: n/a |
| `supplier_reply_readings_request_idx` | `supplier_reply_readings` | `(request_id, message_id desc nulls last)` | o embutido de QR2 (um pedido, na ordem da projeção); QR5 (`request_id=eq` com `message_id=gt`/`not.is.null`); e a junção do embutido de QR1 pela FK `request_id`. A coluna de igualdade vem primeiro, depois a de ordem ([Multicolumn Indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html)) | tabela nova: n/a |
| `outbox_supplier_emails_pkey` (#156) | `outbox_supplier_emails` | `(id)` | QR2, QF1 a QF4, o `order=id` de QR1 | já existe |
| `kit_fornecedores_pkey` (existente) | `kit_fornecedores` | `(fornecedor_id)` | o embutido `kit_fornecedores(razao_social)` de QR1/QR2 | já existe |
| `invoices_pkey` (existente) | `invoices` | `(access_key)` | QR1b | já existe |

**Sem índice em `outbox_supplier_emails.status` para QR1.** A lista lê todo pedido enviado, porque as contagens são de todos os filtros, e `sent` é o estado de quase todo pedido. Para um valor que cobre a maior parte das linhas, o planejador não usa índice (mesma página de Partial Indexes, como argumentou a #156). Um índice em `status` não teria consulta (IDX-2).

**Sem índice na FK `inbox_supplier_messages.request_id`.** Nenhuma consulta desta camada filtra ou junta a caixa pelo pedido, e nada é apagado em `outbox_supplier_emails` (`deletion: none`), então não há cascata ([Foreign Keys](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-FK)). O índice `(request_id, id)` entra com a consulta da conversa na gaveta, a entrega de tela seguinte.

## Transações

Toda gravação é uma requisição PostgREST, uma transação, uma tabela (`unit_of_work: postgrest-request`). Nenhum adaptador abre transação.

| Caso de uso | Unidade de trabalho | Raiz alterada | Gravações dentro | Na falha | Efeito em outra raiz |
|---|---|---|---|---|---|
| Ler a resposta (`reply-task.run`), gravar a leitura | o `POST` de QR3 | a leitura (fato do pedido) | uma linha em `supplier_reply_readings`; duplicada pela mensagem é ignorada | erro sobe e nada foi gravado; a mensagem segue `pending`, e o runner retenta | marcar a mensagem: passo seguinte, idempotente (abaixo) |
| Ler a resposta: marcar lida | o `PATCH` de QI3 (`ok`) | a mensagem | `read_status`, `read_status_at` | erro sobe; a leitura já está no log, a mensagem segue `pending`; a rodada seguinte relê, QR3 ignora a duplicada e QI3 marca | nenhum |
| Leitura recusada (`markError`) | o `PATCH` de QI3 (`error`) | a mensagem | `read_status`, `read_error` (formato fechado), `read_status_at` | erro sobe; a mensagem segue `pending` e é relida | nenhum |
| Varredura do prazo (`sweepOverdue`) | um `POST` de QR4 por pedido vencido | a leitura | uma linha `no_reply` | 409 `23505`: já havia, `superseded`; outro erro sobe; as anteriores ficam, cada uma independente | nenhum |
| Rascunho da cobrança (a varredura do prazo, #157) | o `PATCH` de QF1 | `SupplierRequest` (cobrança) | `follow_up_draft`, versão, histórico | 0 linhas com rascunho/recusa já gravados: volta sem gravar; outro 0 ou erro sobe | nenhum |
| Enviar a cobrança: reivindicar | o `PATCH` de QF2 | `SupplierRequest` | `follow_up_claimed_at`, `follow_up_claim`, versão, histórico | 0 linhas: `send_in_progress`, sem e-mail | nenhum |
| Enviar a cobrança: e-mail | fora do banco (`FollowUpMailer`) | n/a | n/a | falha vai para QF3 | o e-mail |
| Enviar a cobrança: falha ou envio | o `PATCH` de QF3 ou QF4 | `SupplierRequest` | falha + solta a reivindicação e a ficha, ou carimbo + mantém a reivindicação e a ficha; versão, histórico | ficha que não é a do chamador: `lost`, sem gravar (o caso de uso devolve `send_in_progress`); outro 0 ou erro sobe; em QF4, a reivindicação presa impede o segundo e-mail | nenhum |
| Lista, `get`, `listSent`, `listPending` | o `GET` de QR1/QR1b/QR2/QI1/QI2 | nenhuma | nenhuma | erro sobe | nenhum |
| Script de exemplo | o `POST` na caixa | a mensagem | quatro linhas, idempotentes por `source_message_id` | erro sobe; reexecutar não duplica | nenhum |

**`recordReading` e `markRead` não dividem uma unidade de trabalho e não precisam dividir.** São duas tabelas, e o PostgREST não dá transação entre duas requisições. A segurança vem de dois pontos: a leitura é idempotente por mensagem (`unique (message_id)`), e a mensagem só sai de `pending` depois da leitura gravada. Se a falha cair entre as duas gravações, sobra uma mensagem `pending` com leitura. A rodada seguinte a relê, chama o Claude de novo, e a segunda leitura é descartada pela restrição. O custo é uma chamada ao Claude a mais, não um dado errado.

**Nenhuma gravação alcança proposta, título ou valor em risco (#157, #157).** Os adaptadores desta camada só gravam em `inbox_supplier_messages`, `supplier_reply_readings` e nas colunas `follow_up_*` de `outbox_supplier_emails`, e o teste confere as tabelas de cada requisição do fake. O banco não recusa por papel, porque o Worker usa a mesma `service_role` em tudo. A recusa é da camada de acesso, como já está registrado para o projeto.

## Inquilino

Nenhum. `strategies.tenancy.strategy: none`. As duas tabelas novas seguem a convenção do projeto: RLS ligado e nenhuma política (`alter table ... enable row level security`). Só a chave secreta (`service_role`, com `BYPASSRLS`) lê e grava, e as recusas são por grant.

## Conferência das regras

| Condição | Atendida por | Não atendida, e por quê |
|---|---|---|
| PER-1 | `inbox_supplier_messages` e `supplier_reply_readings` entram no registro; `outbox_supplier_emails` ganha `extended_by: "#157"` | nenhum |
| PER-2 | `supplier_reply_readings`: o adaptador só faz `select` e `insert`; o `revoke` recusa o resto | nenhum |
| PER-3 | QF1 a QF4 acrescentam a entrada de histórico no mesmo `PATCH`; a caixa guarda a transição na linha, com quem (`read_status_by`), quando e o motivo | o `by` da reivindicação e da falha só existe depois da mudança de porta abaixo. A caixa guarda o `by` (`read_status_by`) na própria linha |
| PER-4 | `version=eq.<lida>` em QF1 a QF4; `read_status=eq.pending` em QI3 | o teste de versão velha roda contra o `FakePostgrest` |
| PER-5 | nenhum `delete` nas três tabelas; `revoke delete` nas duas novas | nenhum |
| PER-6 | a leitura atual vem de `currentReading`, sobre as leituras ordenadas; o teste a remonta | nenhum |
| PER-7 | modo novo de tabela nova; o modo de `outbox_supplier_emails` não muda | n/a |
| PER-8 | `in-row-transition` (extensão registrada do projeto, uma transição terminal), `none`, `json-column` (#156) | nenhum |
| TRX-1 | cada gravação é uma requisição; entidade, histórico e versão da cobrança cabem num `PATCH` | nenhum |
| TRX-2 | nenhum adaptador emite `BEGIN`/`COMMIT` | nenhum |
| TRX-3 | cada gravação toca uma raiz | ler a resposta grava a leitura e depois marca a mensagem em duas requisições; a segurança é a idempotência por mensagem (acima), não um evento na mesma transação. É a mesma decisão da #156 (passo idempotente), ainda sem ADR |
| TRX-4 | o PostgREST confirma ou desfaz cada requisição | nenhum |
| IDX-1 | QI1 a QI3, QR1 a QR5 e QF1 a QF4 têm índice acima, ou leitura inteira justificada (QR1) | se a camada não testar contra banco de verdade, nenhum teste lê o plano. O detector seria um teste de integração com `EXPLAIN` em QI1 e no embutido de QR2, com linhas semeadas |
| IDX-2 | cada índice novo tem a consulta ao lado | nenhum |
| IDX-3 | n/a (relacional) | |
| IDX-4 | os índices novos são de tabelas novas; `outbox_supplier_emails` só ganha colunas e `CHECK`s (trava curta, tabela pequena, acima) | nenhum |
| MT-1 a MT-5 | sem inquilino | n/a |

## Testes que a camada traz

- **Texto da migração:**
  - o `revoke update, delete, truncate` em `supplier_reply_readings`;
  - o `revoke` e o `grant update (read_status, read_error, read_status_at, read_status_by)` em `inbox_supplier_messages`;
  - os `check` `-- ADR-002`, os formatos fechados de `read_error`, `follow_up_rejection` e `follow_up_failure`;
  - o índice único parcial `where message_id is null` com o predicado exato;
  - `unique (message_id)`, a FK composta, RLS ligado nas duas tabelas novas.
- **Projeção** (`currentReading`): leituras gravadas em qualquer ordem dão a de maior `message_id`. `no_reply` só vale sem leitura de mensagem. A resposta tardia vence o `no_reply` (#157).
- **QR3:**
  - leitura da mensagem 5 depois da 7 grava e devolve `superseded`, e a atual continua a da 7;
  - a mesma mensagem duas vezes deixa uma linha e devolve `recorded`.
- **QR4:** a segunda varredura do mesmo pedido devolve `superseded` (o fake responde 409 `23505`). A varredura num pedido com leitura de mensagem grava e devolve `superseded`.
- **QI3:** `markRead` de mensagem já `ok` é idempotente. `markError` com um texto fora do formato é recusado pelo banco (texto da migração) e nunca é gravado pelo adaptador.
- **QF2:** duas reivindicações na mesma versão: uma ganha, a outra volta `false`. Depois de QF4, nova reivindicação volta `false`. Depois de QF3, volta `true`. Dentro do prazo (`LEASE_MS`) a reivindicação de pé recusa, e vencida é retomada.
- **Online** (`api/test/supplier/online-reply.test.ts`, pula sem as credenciais): o catálogo (`service_role` sem `UPDATE`/`DELETE` em `supplier_reply_readings` e só as colunas concedidas em `inbox_supplier_messages`), o `EXPLAIN` de QI1 e das leituras por pedido com os índices nomeados, e um `PATCH` de versão velha que atinge 0 linhas.
- **QF1:** com rascunho ou recusa já gravados, não grava de novo (#157).
- **#157 e #157:** nenhuma requisição do fake fora das três tabelas, e nenhum `PATCH` em `outbox_supplier_emails` leva coluna fora de `follow_up_*`, `version`, `history` e `updated_at`.
- **#157** (`api/test/supplier/supabase-reply-confirm-document.test.ts`): o `PATCH` da confirmação leva só `version`, `history` e `updated_at`, guardado por `version` e `status=eq.sent`; duas confirmações juntas gravam uma; a versão que andou no meio volta `stale`; a leitura nova com outro documento deixa a confirmação para trás.
- **Script** (`scripts/sample_supplier_replies.py` e `scripts/sample_supplier_replies_test.py`): rodar duas vezes deixa quatro mensagens.
- **`FakePostgrest`:** o construtor confere se ele já entende embutido com ordem (`<tabela>.order=`), `gt.`, `not.is.null`, `limit` e o 409 `23505` de índice parcial, e estende o que faltar.

## Mudanças de porta (camada de casos de uso, #157)

- `claimFollowUpSend(id, by)` e `recordFollowUpFailure(id, reason, by)`. O histórico pede quem (PER-3), e `sendFollowUp` já recebe `by`. **#157, rodada 3:** `claimFollowUpSend` devolve a ficha (`string | null`, no lugar de `boolean`), e `recordFollowUpFailure(id, claim, reason, by)` e `recordFollowUpSent(id, claim, stamp)` a recebem e devolvem `'recorded' | 'lost'`. `saveFollowUpDraft` grava com `by` = o nome da tarefa, sem mudar a assinatura. **#157:** a tarefa saiu; `saveFollowUpDraft(id, text, dueOn)` grava com `by` = `supplier-overdue-sweep`, `recordFollowUpRejection` foi removida da porta, e `editFollowUpDraft(id, text, by)` é a gravação nova, da pessoa.
- A docstring de `ReadingRecorded`/`recordReading`: `superseded` passa a significar "gravada no log, mas não é a leitura atual" (QR5). O UPDATE condicional na linha vira gravação append-only com a projeção pela ordem das mensagens. As garantias que a docstring pede continuam de pé (a leitura antiga não troca a nova; a tardia vence o `no_reply`), mas pelo outro mecanismo.
- O comentário de `reply-task.ts` sobre "UPDATE condicional no id da mensagem guardada" muda pelo mesmo motivo.

- `confirmDocument(id, confirmation)` (#157): a porta ganha a gravação da confirmação (`'recorded' | 'already_confirmed' | 'stale'`), e `ReplyRequest` ganha `documentConfirmation`, derivada do histórico.

## Em aberto

- **Texto da #157.** O "What" e o AC-2 falam das "colunas da leitura do pedido". Com este desenho, a leitura mora em `supplier_reply_readings`, e só `follow_up_*` fica no pedido. Quem atualiza o texto da issue e o nome dos testes: o tech lead da #157 (Athena).
- **Mudanças de porta acima.** Quem decide: o tech lead da #157. Quem faz: o construtor da camada.
- **A cobrança e uma resposta lida no meio.** Uma resposta lida entre o `get` e a reivindicação deixa a cobrança sair (acima). A janela maior, a resposta que está na caixa e ainda não foi lida pelo Cron, existe em qualquer desenho. Quem decide se a reivindicação deve recusar quando há mensagem `pending` do pedido: o tech lead da #157. Isso seria uma consulta a mais antes da reivindicação, não uma guarda atômica.
- **Reivindicação presa: resolvida.** A reivindicação tem o prazo da #156 (`LEASE_MS`, 5 minutos). Um processo que morre entre a reivindicação e QF3/QF4 prende a cobrança só até o prazo; depois, a reivindicação seguinte a retoma. O custo, aceito, é o segundo e-mail se o processo morto chegou a enviar antes de gravar o carimbo.
- **Ordem dos ids da caixa.** "A mensagem mais nova vence" usa a ordem de inserção. Com um escritor (o script) ela é a ordem de chegada. Com um webhook concorrente, duas inserções podem confirmar fora da ordem dos ids. Quem decide se `received_at` passa a desempatar: a issue do webhook de entrada (backlog do épico).
- **QR1b e o tamanho da URL.** `invoices?access_key=in.(...)` cresce com os pedidos. A alternativa é a FK `outbox_supplier_emails.invoice_access_key → invoices`. Quem decide: o mantenedor (é a tabela da #156).
- **Apagamento (LGPD).** `from_address` e `body` da caixa podem trazer dado pessoal do contato do fornecedor, e `follow_up_sent_by` identifica uma pessoa. Não há caminho de apagamento registrado no projeto. Quem decide: o mantenedor.
- **ADR a registrar** (herdada da #156 e ampliada aqui): "a unidade de trabalho é uma requisição PostgREST; o histórico mora em `jsonb` na linha; o efeito em outra raiz é passo idempotente; fatos em tabela append-only com projeção pela ordem". Alternativas: funções no banco chamadas por RPC, conexão direta ao Postgres. Quem aprova: o mantenedor.
- **Detector de plano.** Sem banco de verdade nos testes, IDX-1 e a conferência dos `revoke`/`grant` ficam sem detector. A #157 pede testes de integração contra o banco com as migrações aplicadas; se existirem, eles leem `EXPLAIN` de QI1 e QR2 e os privilégios da `service_role` no catálogo.
