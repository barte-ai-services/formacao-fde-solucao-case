-- #311 A rodada do Cron grava os passos periféricos que falharam e quantos subrequests gastou.
-- #311 A rodada com passo periférico falho continua `ok` no status (o enum e o check não mudam): quem diz que algo falhou é failed_steps.
-- #311 Só nomes fixos dos passos (ex.: dock, claude), nunca mensagem de erro. Linhas antigas ficam com a lista vazia e sem contagem (null).
alter table public.automation_runs
  add column failed_steps text[] not null default '{}',
  add column subrequests integer;
