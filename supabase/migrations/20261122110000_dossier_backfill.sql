-- #311 AC-4 O backfill das propostas que já existiam sem dossiê: entram na fila (status pending) e o cron do dossiê as gera,
-- uma leva por invocação. Os mesmos critérios de `needsDossier` (api/src/claude/tasks/dossier.ts): a proposta espera uma
-- pessoa (aguardando_aprovacao, sem aprovação) e a rota não é a regra; e ainda sem a linha ok do dossiê em claude_suggestions.
-- #311 Idempotente: o índice único parcial de dossier_requests (input_key, status = pending) faz o `on conflict do nothing`
-- ignorar a nota que já está na fila; rodar de novo não duplica.
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
on conflict (input_key) where status = 'pending' do nothing;
