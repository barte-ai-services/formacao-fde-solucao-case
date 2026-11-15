-- Tabelas do domínio da conferência e as caixas de saída dos conectores (#59).
-- Dinheiro sempre em centavos (bigint). RLS ligado em toda tabela e nenhuma política (AC-6 do #59):
-- #59 só o Worker lê e grava, com a chave secreta.

-- #59 Nota fiscal capturada da SEFAZ. Regra 1: única pela chave de acesso.
create table public.invoices (
  access_key text not null,
  number text not null,
  series text not null,
  supplier_id text not null,
  store text not null,
  issued_on date not null,
  purchase_order_ref text,
  entry_channel text not null,
  total_cents bigint not null,
  items jsonb not null,
  state text not null default 'a_conferir',
  classification text,
  captured_at timestamptz not null default now(),
  checked_at timestamptz,
  constraint invoices_pkey primary key (access_key),
  constraint invoices_state_check check (state in ('a_conferir', 'conferida', 'com_proposta', 'decidida')),
  constraint invoices_total_cents_check check (total_cents >= 0)
);
alter table public.invoices enable row level security;

-- #59 Divergências achadas na conferência. Regra 6: toda divergência cita evidência.
create table public.divergences (
  invoice_access_key text not null,
  seq integer not null,
  classification text not null,
  skus text[] not null default '{}',
  evidence jsonb not null,
  constraint divergences_pkey primary key (invoice_access_key, seq),
  constraint divergences_invoice_fkey foreign key (invoice_access_key) references public.invoices (access_key) on delete cascade,
  constraint divergences_evidence_check check (jsonb_array_length(evidence) > 0)
);
alter table public.divergences enable row level security;

-- #59 Proposta do agente para a nota.
create table public.proposals (
  id bigint generated always as identity,
  invoice_access_key text not null,
  classification text not null,
  dock_action jsonb not null,
  approval_level text not null,
  amount_at_risk_cents bigint not null,
  justification text not null,
  state text not null default 'registrada',
  created_at timestamptz not null default now(),
  constraint proposals_pkey primary key (id),
  constraint proposals_invoice_fkey foreign key (invoice_access_key) references public.invoices (access_key) on delete cascade,
  constraint proposals_level_check check (approval_level in ('regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio')),
  constraint proposals_state_check check (state in ('registrada', 'aguardando_aprovacao', 'aprovada', 'alterada')),
  constraint proposals_amount_check check (amount_at_risk_cents >= 0)
);
alter table public.proposals enable row level security;

-- #59 Aprovação da proposta. Regra 8: uma vez só por proposta.
create table public.approvals (
  id bigint generated always as identity,
  proposal_id bigint not null,
  approver text not null,
  approver_level text not null,
  justification text,
  approved_at timestamptz not null default now(),
  constraint approvals_pkey primary key (id),
  constraint approvals_proposal_fkey foreign key (proposal_id) references public.proposals (id) on delete cascade,
  constraint approvals_proposal_key unique (proposal_id),
  constraint approvals_level_check check (approver_level in ('regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio'))
);
alter table public.approvals enable row level security;

-- #59 Título a pagar da nota.
create table public.titles (
  invoice_access_key text not null,
  amount_cents bigint not null,
  due_on date not null,
  state text not null default 'lancado',
  updated_at timestamptz not null default now(),
  constraint titles_pkey primary key (invoice_access_key),
  constraint titles_invoice_fkey foreign key (invoice_access_key) references public.invoices (access_key) on delete cascade,
  constraint titles_state_check check (state in ('lancado', 'liberado', 'reduzido', 'bloqueado', 'na_lista_do_dia')),
  constraint titles_amount_check check (amount_cents >= 0)
);
alter table public.titles enable row level security;

-- #59 Caixa de saída: ação na doca, para o WMS.
create table public.outbox_dock_actions (
  id bigint generated always as identity,
  invoice_access_key text not null,
  payload jsonb not null,
  published_at timestamptz not null default now(),
  constraint outbox_dock_actions_pkey primary key (id)
);
alter table public.outbox_dock_actions enable row level security;

-- #59 Caixa de saída: correção de cadastro (E8 e E4), para o ERP Cadastro.
create table public.outbox_registry_corrections (
  id bigint generated always as identity,
  invoice_access_key text not null,
  payload jsonb not null,
  published_at timestamptz not null default now(),
  constraint outbox_registry_corrections_pkey primary key (id)
);
alter table public.outbox_registry_corrections enable row level security;

-- #59 Caixa de saída: nota de devolução, para o ERP.
create table public.outbox_return_notes (
  id bigint generated always as identity,
  invoice_access_key text not null,
  payload jsonb not null,
  published_at timestamptz not null default now(),
  constraint outbox_return_notes_pkey primary key (id)
);
alter table public.outbox_return_notes enable row level security;
