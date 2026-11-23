-- #356 O modo demonstração, a trava da rodada e o que a rodada passa a gravar em automation_runs.
-- #356 Expandir antes de usar: esta migração só cria e acrescenta; o Worker passa a usá-las no PR da camada seguinte, e o código que já
-- #356 roda (as portas em api/src/automation/round-store.ts) se comporta bem enquanto ela não foi aplicada.
-- #356 RLS ligado e nenhuma política: só a chave secreta do Worker lê e grava.

-- #356 AC-1 O modo demonstração: UMA linha (a chave é o booleano `true` e o check impede outra). Ligado, a rodada roda todo minuto;
-- #356 AC-1 desligado, de 15 em 15. Muda no banco, sem deploy. changed_by é o e-mail do Access de quem mudou (nulo no service token).
-- #356 AC-2 version e history: cada troca sobe a versão e acrescenta {version, at, by, enabled} ao history, num PATCH filtrado pela versão
-- #356 AC-2 lida (como outbox_supplier_emails): a escrita sobre estado velho não pega linha. O history guarda o e-mail só no banco (RLS sem política).
create table public.demo_settings (
  id boolean primary key default true,
  enabled boolean not null default false,
  changed_by text,
  changed_at timestamptz not null default now(),
  version integer not null default 1,
  history jsonb not null default '[]',
  constraint demo_settings_single_row check (id)
);
alter table public.demo_settings enable row level security;
insert into public.demo_settings (id) values (true) on conflict (id) do nothing;

-- #356 AC-3 A trava da rodada: UMA linha com o dono e a validade. Sem linha ou com a validade vencida, a trava está livre; o Worker que
-- #356 AC-3 morre com ela tomada a perde sozinho quando vence. A validade de 5 minutos é a LOCK_TTL_MS de api/src/automation/round.ts:
-- #356 AC-3 maior que os 3 min + 45 s que a rodada dura no máximo (o medidor corta o fetch novo aos 3 min e o fetch em curso leva até 45 s),
-- #356 AC-3 então a rodada viva nunca a perde, e curta o bastante para o modo de 1 minuto perder no máximo 5 rodadas (gravadas como skipped).
create table public.automation_lock (
  id boolean primary key default true,
  owner text not null,
  expires_at timestamptz not null,
  constraint automation_lock_single_row check (id)
);
alter table public.automation_lock enable row level security;

-- #356 AC-3 Toma a trava para p_owner por p_valid_for_ms. Uma requisição, uma instrução: o insert ... on conflict do update ... where
-- #356 AC-3 trava a linha, então duas rodadas simultâneas nunca tomam as duas. O relógio é o do banco (now()), não o do Worker: sem
-- #356 AC-3 diferença de relógio entre quem toma e quem confere. Devolve verdadeiro a quem tomou e falso a quem achou a trava válida de outro.
create function public.take_automation_lock(p_owner text, p_valid_for_ms integer)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_owner text;
begin
  if p_owner is null or p_owner = '' or p_valid_for_ms is null or p_valid_for_ms <= 0 then
    raise exception 'dono e validade da trava são obrigatórios';
  end if;
  insert into public.automation_lock as l (id, owner, expires_at)
  values (true, p_owner, now() + p_valid_for_ms * interval '1 millisecond')
  on conflict (id) do update set owner = excluded.owner, expires_at = excluded.expires_at
  where l.expires_at <= now()
  returning l.owner into v_owner;
  return v_owner is not null;
end;
$$;

-- #356 AC-3 Solta só a trava do dono: a de outro dono, que tomou depois de a primeira vencer, fica como está. Devolve se soltou.
create function public.release_automation_lock(p_owner text)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  delete from public.automation_lock where owner = p_owner;
  return found;
end;
$$;

-- #356 AC-3 Só a chave secreta do Worker (service_role) chama as funções: ninguém mais toma a trava para travar a automação.
revoke execute on function public.take_automation_lock(text, integer) from public, anon, authenticated;
grant execute on function public.take_automation_lock(text, integer) to service_role;
revoke execute on function public.release_automation_lock(text) from public, anon, authenticated;
grant execute on function public.release_automation_lock(text) to service_role;

-- #356 AC-3 AC-4 automation_runs: a rodada pulada (`skipped`, a trava estava tomada), a origem (as linhas antigas são do Cron), se o modo
-- #356 AC-3 AC-4 demonstração estava ligado e os passos que a rodada adiou para a seguinte (nomes fixos, nunca mensagem de erro).
alter table public.automation_runs
  drop constraint automation_runs_status_check,
  add constraint automation_runs_status_check check (status in ('ok', 'failed', 'skipped')),
  add column origin text not null default 'cron',
  add constraint automation_runs_origin_check check (origin in ('cron', 'manual')),
  add column demo_enabled boolean not null default false,
  add column deferred_steps text[] not null default '{}';
