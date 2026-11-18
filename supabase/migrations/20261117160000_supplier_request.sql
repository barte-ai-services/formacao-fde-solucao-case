-- #12 Persistência do pedido ao fornecedor (#2): o e-mail de cada fornecedor, a nota emitida pelo mock e o pedido.
-- #12 RLS ligado e nenhuma política: só a chave secreta (service_role) lê e grava, como nas demais tabelas.
-- #12 O desenho e o modo de cada tabela: supabase/persistence-supplier-request.md e supabase/persistence-modes.yaml.

-- #12/AC-1 O e-mail de teste do fornecedor. Anulável: a migração roda antes da carga (scripts/load_kit.py), que o preenche.
alter table public.kit_fornecedores add column email text;
alter table public.kit_fornecedores
  add constraint kit_fornecedores_email_check check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+$');

-- #12/AC-2 A nota emitida pelo mock: um fato imutável (append-only), uma por devolução da fila (#140).
-- #12/AC-2 O id é a sequência da emissão: ND-<id>, número <id>, série 9. A chave de acesso e o emitente não são
-- #12/AC-2 colunas: issueReturnNote (api/src/domain/return-note-document.ts) os refaz iguais a cada leitura.
-- #12/PER-5 queue_id referencia outbox_return_notes só por identidade, sem FK: o reconferir (#56) apaga a fila e as linhas
-- #12/PER-5 desta tabela e de outbox_supplier_emails sobrevivem como referência órfã, por desenho.
create table public.issued_return_notes (
  id bigint generated always as identity (maxvalue 999999999),
  queue_id bigint not null,
  invoice_access_key text not null,
  supplier_id text not null,
  issued_on date not null,
  note jsonb not null,
  created_at timestamptz not null default now(),
  constraint issued_return_notes_pkey primary key (id),
  constraint issued_return_notes_queue_id_key unique (queue_id),
  constraint issued_return_notes_supplier_fkey foreign key (supplier_id) references public.kit_fornecedores (fornecedor_id),
  constraint issued_return_notes_note_check check (jsonb_typeof(note) = 'object')
);
alter table public.issued_return_notes enable row level security;
-- #12/AC-2 service_role tem BYPASSRLS: o que recusa o update e o delete é o grant, não a RLS.
revoke update, delete, truncate on public.issued_return_notes from anon, authenticated, service_role;

-- #12/AC-4 O pedido ao fornecedor (raiz SupplierRequest): entidade editada, com histórico na própria linha.
-- #12/AC-4 Cada gravação é um PATCH filtrado por `version` e acrescenta uma entrada em `history`
-- #12/AC-4 ({version, at, by, action, state}); nada é apagado: o fim é `discarded`, com motivo, quem e quando.
-- #12/AC-4 ADR-005: só os atos humanos (enviar, descartar) têm quem e quando; não há created_by nem updated_by.
create table public.outbox_supplier_emails (
  id bigint generated always as identity,
  invoice_access_key text not null,
  queue_id bigint not null,
  supplier_id text not null,
  request_type text not null,
  recipient text not null,
  subject text not null,
  body text not null,
  asks jsonb not null,
  note jsonb not null,
  attachments jsonb not null default '[]',
  drafted_on date not null,
  due_on date not null,
  model text not null,
  status text not null default 'draft',
  discard_reason text,
  send_failure_reason text,
  issued_return_note_id bigint,
  channel text,
  provider_message_id text,
  sent_by text,
  sent_at timestamptz,
  discarded_by text,
  discarded_at timestamptz,
  version integer not null default 1,
  history jsonb not null default '[]',
  send_claim uuid,
  send_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outbox_supplier_emails_pkey primary key (id),
  constraint outbox_supplier_emails_supplier_fkey foreign key (supplier_id) references public.kit_fornecedores (fornecedor_id),
  constraint outbox_supplier_emails_issued_fkey foreign key (issued_return_note_id) references public.issued_return_notes (id),
  constraint outbox_supplier_emails_request_type_check check (request_type in ('return_note')), -- ADR-002
  constraint outbox_supplier_emails_status_check check (status in ('draft', 'sent', 'send_failed', 'discarded')), -- ADR-002
  constraint outbox_supplier_emails_channel_check check (channel in ('mock', 'resend')), -- ADR-002
  constraint outbox_supplier_emails_asks_check check (jsonb_typeof(asks) = 'array'),
  constraint outbox_supplier_emails_attachments_check check (jsonb_typeof(attachments) = 'array'),
  constraint outbox_supplier_emails_history_check check (jsonb_typeof(history) = 'array'),
  -- #12/AC-4 Coerência do estado, no estilo da fila de devolução (#140): enviado leva o carimbo, descartado leva o motivo.
  constraint outbox_supplier_emails_sent_check check (
    (status = 'sent') = (sent_by is not null and sent_at is not null and channel is not null and provider_message_id is not null)
  ),
  constraint outbox_supplier_emails_discarded_check check ((status = 'discarded') = (discard_reason is not null)),
  constraint outbox_supplier_emails_discarded_stamp_check check ((discarded_by is null) = (discarded_at is null)),
  constraint outbox_supplier_emails_failed_check check (status <> 'send_failed' or send_failure_reason is not null),
  constraint outbox_supplier_emails_issued_sent_check check (status <> 'sent' or request_type <> 'return_note' or issued_return_note_id is not null),
  constraint outbox_supplier_emails_claim_check check ((send_claim is null) = (send_claimed_at is null))
);
alter table public.outbox_supplier_emails enable row level security;

-- #12/AC-3 Uma nota de origem não tem dois pedidos abertos do mesmo tipo. O filtro do findOpen repete este predicado.
create unique index outbox_supplier_emails_open_key on public.outbox_supplier_emails (invoice_access_key, request_type)
  where status in ('draft', 'sent', 'send_failed'); -- ADR-002

-- #12 O findLatest (Q6) lê o pedido mais recente da nota e do tipo (invoice_access_key, request_type, order id desc, limit 1).
create index outbox_supplier_emails_latest on public.outbox_supplier_emails (invoice_access_key, request_type, id desc);

-- #12 O listByStatus (Q7) lê os mais novos de um estado (status, order id desc, limit).
create index outbox_supplier_emails_status on public.outbox_supplier_emails (status, id desc);
