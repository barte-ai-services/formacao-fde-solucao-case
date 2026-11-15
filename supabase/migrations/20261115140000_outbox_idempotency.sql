-- #59 Idempotência das caixas de saída: publicar a mesma mensagem duas vezes grava uma linha só.
-- #59 A chave é a chave da nota mais o sha256 do payload canônico; as tabelas estão vazias, então not null entra direto.
-- #59 RLS segue ligado e sem política nas três tabelas (AC-6).

alter table public.outbox_dock_actions add column idempotency_key text not null;
alter table public.outbox_dock_actions add constraint outbox_dock_actions_idempotency_key_key unique (idempotency_key);
alter table public.outbox_dock_actions enable row level security;

alter table public.outbox_registry_corrections add column idempotency_key text not null;
alter table public.outbox_registry_corrections add constraint outbox_registry_corrections_idempotency_key_key unique (idempotency_key);
alter table public.outbox_registry_corrections enable row level security;

alter table public.outbox_return_notes add column idempotency_key text not null;
alter table public.outbox_return_notes add constraint outbox_return_notes_idempotency_key_key unique (idempotency_key);
alter table public.outbox_return_notes enable row level security;
