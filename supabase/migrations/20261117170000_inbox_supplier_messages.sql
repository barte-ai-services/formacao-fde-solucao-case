-- #35 Persistência da leitura da resposta do fornecedor (#4): a caixa de entrada mock, as leituras e a cobrança.
-- #35 RLS ligado e nenhuma política: só a chave secreta (service_role) lê e grava, como nas demais tabelas.
-- #35 O desenho e o modo de cada tabela: supabase/persistence-supplier-reply.md e supabase/persistence-modes.yaml.
-- #35 Nenhuma tabela nova representa o pedido: as chaves estrangeiras apontam para outbox_supplier_emails (#12).

-- #4/AC-1 A mensagem da caixa de entrada mock: um fato que nunca muda. Só read_status, read_error, read_status_at e read_status_by
-- #4/AC-1 saem de `pending` uma vez, para `ok` ou `error` (a transição fica na própria linha, sem histórico à parte).
create table public.inbox_supplier_messages (
  id bigint generated always as identity,
  request_id bigint not null,
  source_message_id text not null,
  from_address text not null,
  body text not null,
  attachments_meta jsonb not null default '[]',
  received_at timestamptz not null default now(),
  read_status text not null default 'pending',
  read_error text,
  read_status_at timestamptz,
  -- #35 PER-3: quem fez a transição (o nome da tarefa da leitura, não uma pessoa); nulo só enquanto pendente.
  read_status_by text,
  created_at timestamptz not null default now(),
  constraint inbox_supplier_messages_pkey primary key (id),
  constraint inbox_supplier_messages_request_fkey foreign key (request_id) references public.outbox_supplier_emails (id),
  -- #4/AC-7 A identidade na origem torna o script de exemplo reexecutável (on_conflict=source_message_id).
  constraint inbox_supplier_messages_source_message_id_key unique (source_message_id),
  -- #35 O alvo da chave estrangeira composta das leituras: a mensagem é do mesmo pedido da leitura.
  constraint inbox_supplier_messages_id_request_key unique (id, request_id),
  constraint inbox_supplier_messages_attachments_check check (jsonb_typeof(attachments_meta) = 'array'),
  constraint inbox_supplier_messages_status_check check (read_status in ('pending', 'ok', 'error')), -- ADR-002
  -- #4/AC-1 O motivo é o fechado `<motivo>: <campo>` da regra; o texto do modelo ou do fornecedor não cabe neste formato.
  constraint inbox_supplier_messages_error_format_check check (read_error is null or read_error ~ '^[a-z_]+: [a-z_]+$'),
  constraint inbox_supplier_messages_pending_check check ((read_status = 'pending') = (read_status_at is null)),
  constraint inbox_supplier_messages_by_check check ((read_status = 'pending') = (read_status_by is null)),
  constraint inbox_supplier_messages_error_check check ((read_status = 'error') = (read_error is not null))
);
alter table public.inbox_supplier_messages enable row level security;

-- #4/AC-1 Lista as pendentes, da mais antiga para a mais nova: o filtro e a ordem da consulta repetem o predicado.
create index inbox_supplier_messages_pending_idx on public.inbox_supplier_messages (id) where read_status = 'pending'; -- ADR-002

-- #35 service_role tem BYPASSRLS: o que recusa é o grant. O privilégio de tabela sai antes, porque o de coluna não o desfaz.
revoke update, delete, truncate on public.inbox_supplier_messages from anon, authenticated, service_role;
grant update (read_status, read_error, read_status_at, read_status_by) on public.inbox_supplier_messages to service_role;

-- #4/AC-1 A leitura: um fato (a mensagem M foi lida assim, ou o prazo venceu sem resposta), num log append-only.
-- #4/AC-1 A leitura atual do pedido é a de maior message_id; a da varredura (message_id nulo) só vale sem leitura de mensagem.
create table public.supplier_reply_readings (
  id bigint generated always as identity,
  request_id bigint not null,
  message_id bigint,
  reply_outcome text not null,
  fulfilled_asks jsonb not null,
  supplier_document text,
  summary text not null,
  injection_flag text,
  next_step text not null,
  read_at timestamptz not null default now(),
  constraint supplier_reply_readings_pkey primary key (id),
  constraint supplier_reply_readings_request_fkey foreign key (request_id) references public.outbox_supplier_emails (id),
  -- #4/AC-1 Uma leitura por mensagem: o alvo do on_conflict, que ignora a leitura repetida da retentativa.
  constraint supplier_reply_readings_message_key unique (message_id),
  -- #35 Com message_id nulo (a varredura) a chave composta não é conferida; com ele, a mensagem tem de ser deste pedido.
  constraint supplier_reply_readings_message_fkey foreign key (message_id, request_id) references public.inbox_supplier_messages (id, request_id),
  constraint supplier_reply_readings_outcome_check check (reply_outcome in ('fulfilled', 'partially_fulfilled', 'refused', 'needs_information', 'no_reply')), -- ADR-002
  constraint supplier_reply_readings_next_step_check check (next_step in ('close', 'confirm_document', 'answer_supplier', 'follow_up')), -- ADR-002
  constraint supplier_reply_readings_asks_check check (jsonb_typeof(fulfilled_asks) = 'array'),
  constraint supplier_reply_readings_summary_check check (btrim(summary) <> ''),
  -- #4/AC-1 As regras do domínio repetidas no banco, para a linha que fugir do domínio não entrar.
  -- #4/AC-1 no_reply só vem da varredura do prazo, e a varredura só grava no_reply com follow_up.
  constraint supplier_reply_readings_no_reply_check check ((reply_outcome = 'no_reply') = (message_id is null)),
  constraint supplier_reply_readings_no_reply_step_check check (reply_outcome <> 'no_reply' or next_step = 'follow_up'),
  -- #4/AC-4 Atendeu com documento citado nunca fecha sozinho: o próximo passo é confirmar o documento.
  constraint supplier_reply_readings_document_check check (reply_outcome <> 'fulfilled' or supplier_document is null or next_step = 'confirm_document'),
  -- #4/AC-4 Só o que foi atendido fecha: recusado, parcial ou pedido de informação pede resposta nossa.
  constraint supplier_reply_readings_close_check check (next_step <> 'close' or reply_outcome = 'fulfilled')
);
alter table public.supplier_reply_readings enable row level security;

-- #4/AC-3 Um único no_reply por pedido: a segunda varredura recebe 409 com 23505, que o adaptador lê como "já havia".
create unique index supplier_reply_readings_one_no_reply on public.supplier_reply_readings (request_id) where message_id is null;

-- #4/AC-5 A leitura de um pedido na ordem da projeção (a de maior message_id primeiro): o embutido da lista e do get, e a
-- #4/AC-5 consulta de "existe leitura mais nova". A coluna de igualdade vem primeiro, depois a de ordem.
create index supplier_reply_readings_request_idx on public.supplier_reply_readings (request_id, message_id desc nulls last);

-- #35 A leitura é um fato: nunca se edita nem se apaga.
revoke update, delete, truncate on public.supplier_reply_readings from anon, authenticated, service_role;

-- #4/AC-3 A cobrança é o segundo e-mail do mesmo pedido e mora na linha dele (#12), sob a versão e o histórico da #12.
-- #4/AC-3 Colunas anuláveis e sem default: ADD COLUMN sem default não reescreve a tabela. Cada CHECK novo varre a tabela
-- #4/AC-3 sob a mesma trava, que aqui é curta (poucas linhas); numa tabela grande, NOT VALID e depois VALIDATE CONSTRAINT.
alter table public.outbox_supplier_emails
  add column follow_up_draft jsonb,
  add column follow_up_rejection text,
  add column follow_up_claimed_at timestamptz,
  -- #35 A ficha da reivindicação (uuid, como o send_claim da #12): a falha e o carimbo filtram por ela, e quem perdeu a reivindicação não grava.
  add column follow_up_claim uuid,
  add column follow_up_sent_by text,
  add column follow_up_sent_at timestamptz,
  add column follow_up_channel text,
  add column follow_up_provider_message_id text,
  add column follow_up_failure text,
  add constraint outbox_supplier_emails_follow_up_draft_check check (follow_up_draft is null or jsonb_typeof(follow_up_draft) = 'object'),
  -- #4/AC-3 O motivo fechado da recusa do texto (#34/AC-3) e o motivo curto da falha do envio (SHORT_REASON de reply-use-cases.ts).
  add constraint outbox_supplier_emails_follow_up_rejection_check check (follow_up_rejection is null or follow_up_rejection ~ '^[a-z_]+: [a-z_]+$'),
  add constraint outbox_supplier_emails_follow_up_failure_check check (follow_up_failure is null or follow_up_failure ~ '^[a-z][a-z0-9_]{0,39}$'),
  add constraint outbox_supplier_emails_follow_up_channel_check check (follow_up_channel in ('mock', 'resend')), -- ADR-002
  -- #4/AC-4 O carimbo do envio (ADR-005, ato humano): quem, quando, canal e identificador no provedor, ou nenhum.
  add constraint outbox_supplier_emails_follow_up_sent_check check (
    (follow_up_sent_at is null) = (follow_up_sent_by is null)
    and (follow_up_sent_at is null) = (follow_up_channel is null)
    and (follow_up_sent_at is null) = (follow_up_provider_message_id is null)
  ),
  add constraint outbox_supplier_emails_follow_up_text_check check (follow_up_draft is null or follow_up_rejection is null),
  add constraint outbox_supplier_emails_follow_up_claim_check check (follow_up_claimed_at is null or follow_up_draft is not null),
  -- #35 A ficha anda junto com o prazo: as duas colunas são nulas ou as duas têm valor, como send_claim e send_claimed_at na #12.
  add constraint outbox_supplier_emails_follow_up_claim_token_check check ((follow_up_claim is null) = (follow_up_claimed_at is null)),
  -- #35 A reivindicação tem o prazo da #12 (LEASE_MS, 5 minutos), aplicado pelo adaptador no filtro do PATCH: a vencida pode ser
  -- #35 retomada, com outra ficha. A falha e o carimbo filtram pela ficha de quem os grava, então quem perdeu a reivindicação recebe
  -- #35 0 linhas e não solta nem carimba a de outro. Risco aceito: se quem a perdeu chegou a enviar e morreu antes do carimbo, sai um
  -- #35 segundo e-mail; o carimbo dele é recusado.
  -- #4/AC-4 O envio mantém a reivindicação (impede o segundo e-mail) e limpa a falha.
  add constraint outbox_supplier_emails_follow_up_kept_claim_check check (follow_up_sent_at is null or follow_up_claimed_at is not null),
  add constraint outbox_supplier_emails_follow_up_cleared_failure_check check (follow_up_sent_at is null or follow_up_failure is null),
  -- #4/AC-3 Só pedido enviado tem cobrança.
  add constraint outbox_supplier_emails_follow_up_status_check check (
    status = 'sent'
    or (follow_up_draft is null and follow_up_rejection is null and follow_up_claimed_at is null and follow_up_claim is null and follow_up_sent_at is null and follow_up_failure is null)
  );
