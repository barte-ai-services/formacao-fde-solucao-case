-- #311 Os índices das duas leituras do dossiê que passam a rodar a cada invocação do cron e na rota admin.
-- #311 (requested_at): o ramo `requested_at.gte` da janela de pedidos (SupabaseDossierRequests.window e since), lido a cada 15 minutos.
-- #311 Parcial (requested_at) onde status é pending ou error: a rota GET /api/admin/dossies (api/src/dossier/overview.ts) lê só eles,
-- do mais novo ao mais velho, e são poucos frente ao total.
-- #311 Sem `concurrently`: dossier_requests tem dezenas de linhas, o lock dura milissegundos, e `concurrently` não roda na transação
-- em que o `supabase db push` aplica o arquivo (o mesmo motivo de 20261122100000).
create index dossier_requests_requested_at_idx on public.dossier_requests (requested_at);
create index dossier_requests_open_requested_at_idx on public.dossier_requests (requested_at) where status in ('pending', 'error');
