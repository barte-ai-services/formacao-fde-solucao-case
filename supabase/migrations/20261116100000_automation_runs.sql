-- #211 Cada rodada do Cron fica gravada: quando começou e terminou, o que fez e como terminou.
-- #211 Só números e a classe do erro; nunca chave de acesso, valor ou mensagem do fornecedor.
-- #211 RLS ligado e nenhuma política: só a chave secreta lê e grava.

create table public.automation_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  status text not null,
  seen integer not null default 0,
  inserted integer not null default 0,
  checked integer not null default 0,
  failed integer not null default 0,
  proposed integer not null default 0,
  approved_by_rule integer not null default 0,
  cadastro_e8 integer not null default 0,
  dock_published integer not null default 0,
  store_published integer not null default 0,
  duplicates_blocked integer not null default 0,
  -- #211 Classe do erro quando a rodada falhou (ex.: SupabaseRestError); nulo quando deu certo.
  error text,
  constraint automation_runs_status_check check (status in ('ok', 'failed')),
  constraint automation_runs_period_check check (finished_at >= started_at)
);
create index automation_runs_started_at_idx on public.automation_runs (started_at desc);
alter table public.automation_runs enable row level security;
