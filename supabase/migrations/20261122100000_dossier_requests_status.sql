-- #311 O pedido do dossiê passa a ter estado e motivo, para a falha do caminho automático deixar rastro.
-- #311 `status`: pending (na fila, ainda ninguém gerou: o backfill das propostas que já existiam), running (o Worker está
-- #311 gerando; é o que a gaveta lê como "Gerando" e o que dá 409), done (fechado com o dossiê gravado) ou error (fechado sem ele).
-- #311 `reason`: o código do motivo, nunca texto livre nem segredo. Do erro: no_credentials (sem credencial do Claude no
-- #311 Worker), rate_limited (429), auth_refused (401/403), claude_failed (outra falha do Claude) e storage_failed (o banco).
-- #311 not_needed fecha em done o pendente de uma proposta que já não espera uma pessoa.
-- #311 O default `running` é o que o `open` do Worker sempre foi: a linha nasce em geração.
alter table public.dossier_requests
  add column status text not null default 'running' check (status in ('pending', 'running', 'done', 'error')),
  add column reason text check (reason in ('no_credentials', 'rate_limited', 'auth_refused', 'claude_failed', 'storage_failed', 'not_needed'));

-- #311 As linhas que já existem: fechadas (finished_at) viram done, as abertas seguem running.
update public.dossier_requests set status = 'done' where finished_at is not null;

-- #311 Um pendente por nota: o backfill é idempotente por este índice (insert ... on conflict do nothing). Ele precisa existir
-- #311 antes da migração do backfill (20261122110000), que o usa no `on conflict`.
-- #311 Por que `create unique index` sem `concurrently`: dossier_requests é pequena (dezenas de linhas, um pedido por nota) e o
-- #311 índice é parcial (só status = 'pending', que nesta migração ainda não tem nenhuma linha), então o lock de escrita dura
-- #311 milissegundos. A decisão está registrada em supabase/persistence-modes.yaml, na entrada dossier_requests (#311).
create unique index dossier_requests_pending_input_key_idx on public.dossier_requests (input_key) where status = 'pending';
