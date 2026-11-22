-- #354 Índices das leituras do GET /api/ao-vivo, que a tela repete a cada poucos segundos: sem eles cada consulta varre a tabela.
-- #354 `create index concurrently` fica de fora: o `supabase db push` roda cada arquivo dentro de uma transação, e o Postgres
-- #354 recusa `concurrently` nela. O índice simples trava a escrita só enquanto se constrói, e as duas tabelas são pequenas.

-- #354 readPersonApprovals: filtra `approved_at > cursor` e ordena por `approved_at desc` (ou asc, ao esvaziar o atraso).
create index if not exists approvals_approved_at_idx on public.approvals (approved_at desc);

-- #354 recentCascade: só as linhas da cascata (`role = 'cascade'`), por `decided_at`; o índice parcial guarda só elas.
create index if not exists engine_decisions_cascade_decided_at_idx on public.engine_decisions (decided_at desc) where role = 'cascade';
