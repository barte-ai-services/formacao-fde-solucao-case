# ADR-008: Os índices de dossier_requests são criados sem `concurrently`

- **Status:** accepted
- **Date:** 2026-11-22

## Context

A #311 dá estado ao pedido do dossiê e cria três índices em `public.dossier_requests`: o único parcial `dossier_requests_pending_input_key_idx` (`supabase/migrations/20261122100000_dossier_requests_status.sql`) e os índices `dossier_requests_requested_at_idx` e `dossier_requests_open_requested_at_idx` (`supabase/migrations/20261122120000_dossier_requests_indexes.sql`). A condição 4 da regra de cobertura de índices (IDX-4, `ahrena-engineering-database:rules/index-coverage.md`) pede `create index concurrently` numa tabela que já recebe escrita, para o índice não travar a escrita enquanto é construído. A revisão do PR #359 levantou essa condição como pergunta.

O deploy aplica as migrações com `supabase db push` no workflow `.github/workflows/supabase-base-do-kit.yml`, que as aplica em bloco. O repositório não dá garantia de que cada arquivo roda fora de uma transação, e `create index concurrently` não roda dentro de uma. O índice único também precisa existir antes da migração do backfill (`20261122110000`), que o usa no `on conflict`.

## Decision

Os três índices de `dossier_requests` da #311 são criados sem `concurrently`, como exceção registrada à IDX-4. `dossier_requests` é pequena (dezenas de linhas, um pedido por nota), o lock de escrita dura milissegundos e fica aceito. Decidido pelo Tech Lead na revisão do PR #359 (#311).

Os três `create index` não usam `if not exists`: quem impede a reaplicação é o histórico de migrações do Supabase, que aplica cada arquivo uma vez.

## Consequences

- O deploy não depende de a CLI do Supabase rodar cada migração fora de transação.
- Enquanto cada índice é construído, a escrita em `dossier_requests` espera; no tamanho de hoje, milissegundos.
- A exceção vale para esta tabela neste tamanho. Um índice novo numa tabela grande, ou em `dossier_requests` depois de ela crescer para milhares de linhas, volta à IDX-4 e pede `concurrently` numa migração aplicada fora de transação.

## Alternatives considered

- `create index concurrently`, como a IDX-4 pede. Rejeitada: pode falhar no `supabase db push` do deploy, se a migração rodar dentro de uma transação, e o ganho é um lock de milissegundos.
- Aplicar os índices numa migração separada, fora do `db push`, com `concurrently`. Rejeitada: cria um segundo caminho de deploy para uma tabela de dezenas de linhas, e o índice único precisa existir antes do backfill da mesma leva.
