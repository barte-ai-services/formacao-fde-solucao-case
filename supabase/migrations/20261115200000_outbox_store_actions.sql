-- #135 Caixa de saída: ação no recebimento da nota de loja (destino LJ-*), para o app da loja.
-- Mesmo padrão das outras caixas (#59): idempotente pela nota e pelo payload; RLS ligado e sem política.
create table public.outbox_store_actions (
  id bigint generated always as identity,
  invoice_access_key text not null,
  payload jsonb not null,
  published_at timestamptz not null default now(),
  idempotency_key text not null,
  constraint outbox_store_actions_pkey primary key (id),
  constraint outbox_store_actions_idempotency_key_key unique (idempotency_key)
);
alter table public.outbox_store_actions enable row level security;
