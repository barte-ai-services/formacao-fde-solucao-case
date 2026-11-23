-- #311 Os índices das duas leituras do dossiê que passam a rodar a cada invocação do cron e na rota admin.
-- #311 (requested_at): o ramo `requested_at.gte` da janela de pedidos (SupabaseDossierRequests.window e since), lido a cada 15 minutos.
-- #311 Parcial (requested_at) onde status é pending ou error: a rota GET /api/admin/dossies (api/src/dossier/overview.ts) lê só eles,
-- #311 do mais novo ao mais velho, e são poucos frente ao total.
-- #311 Sem `concurrently`: dossier_requests tem dezenas de linhas e o lock dura milissegundos. A decisão está registrada em
-- #311 supabase/persistence-modes.yaml, na entrada dossier_requests (o mesmo motivo de 20261122100000).
create index dossier_requests_requested_at_idx on public.dossier_requests (requested_at);
create index dossier_requests_open_requested_at_idx on public.dossier_requests (requested_at) where status in ('pending', 'error');
