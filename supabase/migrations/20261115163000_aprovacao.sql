-- #63 Aprovação: a linha da régua na proposta, a ação final e o dia da decisão na aprovação.
-- #63 Uma proposta por nota (o modelo: NotaFiscal 1 -- 0..1 Proposta), para o Cron propor sem repetir.
-- #63 RLS segue ligado e sem política nas tabelas (AC-6 do #59): só o Worker lê e grava.

alter table public.proposals add column regua_line smallint;
alter table public.proposals add constraint proposals_regua_line_check check (regua_line between 1 and 6);
alter table public.proposals add constraint proposals_invoice_key unique (invoice_access_key);
alter table public.proposals enable row level security;

alter table public.approvals add column dock_action jsonb;
alter table public.approvals add column decided_on date;
alter table public.approvals enable row level security;
