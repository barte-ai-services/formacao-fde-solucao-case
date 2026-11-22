-- #311 AC-4 O backfill das propostas que já existiam sem dossiê: entram na fila (status pending) e o cron do dossiê as gera,
-- #311 uma leva por invocação. Os mesmos critérios de `needsDossier` (api/src/claude/tasks/dossier.ts): a proposta espera uma
-- #311 pessoa (aguardando_aprovacao, sem aprovação) e a rota não é a regra; e ainda sem a linha ok do dossiê em claude_suggestions.
-- #311 Idempotente: o índice único parcial de dossier_requests (input_key, status = pending) faz o `on conflict do nothing`
-- #311 ignorar a nota que já está na fila; rodar de novo não duplica.
-- #311 Fica de fora a nota cujo dossiê já esgotou as tentativas (error com 3 tentativas, o MAX_ATTEMPTS de api/src/claude/runner.ts):
-- #311 o cron nunca a põe num lote, e o pendente ficaria para sempre na janela e na rota admin.
insert into public.dossier_requests (input_key, requested_by, requested_at, finished_at, trigger, status)
select p.invoice_access_key, 'backfill', now(), null, 'event', 'pending'
from public.proposals p
where p.state = 'aguardando_aprovacao'
  and p.approval_level <> 'regra'
  and not exists (select 1 from public.approvals a where a.proposal_id = p.id)
  and not exists (
    select 1 from public.claude_suggestions s
    where s.task = 'dossier' and s.input_key = p.invoice_access_key and s.status = 'ok'
  )
  and not exists (
    select 1 from public.claude_suggestions s
    where s.task = 'dossier' and s.input_key = p.invoice_access_key and s.status = 'error' and s.attempts >= 3
  )
on conflict (input_key) where status = 'pending' do nothing;
