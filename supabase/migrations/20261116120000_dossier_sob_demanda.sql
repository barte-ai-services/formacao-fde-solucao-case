-- #130 O dossiê pedido na gaveta (sob demanda), além do que o evento dispara (#38).
-- #130 As colunas novas de claude_suggestions são nulas: as outras tarefas (description-match,
-- probable-order) não as gravam e continuam valendo como estão.

-- #130 `generating` entra no domínio do status, para quem quiser marcar a linha durante a geração.
alter table public.claude_suggestions drop constraint claude_suggestions_status_check;
alter table public.claude_suggestions
  add constraint claude_suggestions_status_check check (status in ('ok', 'error', 'generating'));

alter table public.claude_suggestions
  -- #130 Quem disparou a geração: o evento da proposta (#38) ou a pessoa na gaveta.
  add column trigger text check (trigger in ('event', 'on_demand')),
  -- #130 Por que a linha está em erro, na língua da gaveta; nulo quando ok.
  add column reason text check (reason in ('claude_failed', 'number_mismatch', 'invalid_shape', 'timeout')),
  -- #130 Tokens de entrada e saída, quando o cliente os expõe.
  add column usage jsonb,
  -- #130 Duração da chamada ao Claude, em milissegundos.
  add column latency_ms integer,
  -- #130 E-mail do Access de quem pediu, só no sob demanda.
  add column requested_by text,
  add column requested_at timestamptz;

-- #130 Os pedidos da gaveta, um por clique aceito. Servem ao 409 (um pedido sem finished_at nos
-- últimos 5 min é geração em andamento; mais velho que isso, abandonado) e ao 429 (3 pedidos por
-- proposta na última hora).
create table public.dossier_requests (
  id bigint generated always as identity primary key,
  -- #130 A chave de acesso da nota, a mesma de claude_suggestions.input_key.
  input_key text not null,
  requested_by text not null,
  requested_at timestamptz not null default now(),
  -- #130 Nulo enquanto a geração roda; o Worker grava ao terminar, com sucesso ou não.
  finished_at timestamptz
);
create index dossier_requests_input_key_requested_at_idx on public.dossier_requests (input_key, requested_at);
-- #130 RLS ligado e nenhuma política, como claude_suggestions: só a chave secreta lê e grava.
alter table public.dossier_requests enable row level security;
