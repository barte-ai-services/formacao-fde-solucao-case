#!/usr/bin/env bash
# #295 Aplica TODAS as migrações de supabase/migrations/ num Postgres de verdade (docker, descartável) e prova a
# trava otimista de proposals.version. Fora do `make check`: o CI não tem docker garantido. Reexecutável.
#
#   scripts/testar_migracoes_postgres.sh
#
# Variáveis: PG_IMAGE (padrão postgres:17-alpine, a major do supabase/config.toml), PG_CONTAINER (nome do contêiner).
# O contêiner não publica porta, usa uma senha local descartável e é removido ao fim, mesmo se um passo falhar.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRACOES="$RAIZ/supabase/migrations"
IMAGEM="${PG_IMAGE:-postgres:17-alpine}"
NOME="${PG_CONTAINER:-pg295-$$}"
NOVA="proposals_version.sql"

docker rm -f "$NOME" >/dev/null 2>&1 || true
trap 'docker rm -f "$NOME" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$NOME" -e POSTGRES_PASSWORD=descartavel -e POSTGRES_DB=teste "$IMAGEM" >/dev/null

for _ in $(seq 1 60); do
  # o entrypoint sobe um servidor temporário antes do definitivo: espera a conexão por TCP, que só o definitivo aceita
  docker exec "$NOME" pg_isready -h 127.0.0.1 -U postgres -d teste -q && break
  sleep 1
done
docker exec "$NOME" pg_isready -h 127.0.0.1 -U postgres -d teste -q

psql() { docker exec -i "$NOME" psql -v ON_ERROR_STOP=1 -X -q -U postgres -d teste "$@"; }

echo "== papéis do Supabase que as migrações usam"
psql <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
SQL

nova_arquivo="$(ls "$MIGRACOES" | grep -- "_$NOVA\$")"
echo "== migrações até a anterior a $nova_arquivo (o banco já tem dados quando a nova chega)"
for f in $(ls "$MIGRACOES"); do
  [ "$f" = "$nova_arquivo" ] && break
  psql -f - < "$MIGRACOES/$f"
  echo "   aplicada $f"
done

echo "== (e) linha que já existia antes da migração"
psql <<'SQL'
insert into public.invoices (access_key, number, series, supplier_id, store, issued_on, entry_channel, total_cents, items, state)
values (repeat('1', 44), '1', '1', 'F1', 'L1', '2026-11-18', 'sefaz', 1000, '[]', 'com_proposta');
insert into public.proposals (invoice_access_key, classification, dock_action, approval_level, amount_at_risk_cents, justification, state)
values (repeat('1', 44), 'E5', '{"kind":"receber"}', 'analista', 0, 'antiga', 'aguardando_aprovacao');
SQL

echo "== a migração nova e as seguintes, em ordem"
aplicar=0
for f in $(ls "$MIGRACOES"); do
  [ "$f" = "$nova_arquivo" ] && aplicar=1
  [ "$aplicar" = 1 ] || continue
  psql -f - < "$MIGRACOES/$f"
  echo "   aplicada $f"
done

echo "== provas"
psql <<'SQL'
\set QUIET off
do $$
declare
  v_id bigint;
  v_version integer;
  v_audit bigint;
  v_rows integer;
  v_level text;
begin
  -- (e) a linha que já existia ficou com a versão 1
  select version into v_version from public.proposals where invoice_access_key = repeat('1', 44);
  assert v_version = 1, format('(e) linha antiga: version = %s, esperado 1', v_version);
  raise notice '(e) ok: a linha que já existia ficou com version = 1';

  -- (a) a linha inserida nasce com a versão 1
  insert into public.invoices (access_key, number, series, supplier_id, store, issued_on, entry_channel, total_cents, items, state)
  values (repeat('2', 44), '2', '1', 'F1', 'L1', '2026-11-18', 'sefaz', 1000, '[]', 'com_proposta');
  insert into public.proposals (invoice_access_key, classification, dock_action, approval_level, amount_at_risk_cents, justification, state)
  values (repeat('2', 44), 'E5', '{"kind":"receber"}', 'analista', 0, 'nova', 'aguardando_aprovacao')
  returning id, version into v_id, v_version;
  assert v_version = 1, format('(a) version = %s, esperado 1', v_version);
  raise notice '(a) ok: a linha inserida nasce com version = 1';

  -- (b) um update qualquer sobe para 2, mesmo mandando version = 99
  update public.proposals set justification = 'editada', version = 99 where id = v_id returning version into v_version;
  assert v_version = 2, format('(b) version = %s, esperado 2', v_version);
  raise notice '(b) ok: update mandando version = 99 deixou version = 2';

  -- (d) o update com a versão antiga (1) afeta 0 linhas; com a atual (2), afeta 1 e sobe para 3
  update public.proposals set justification = 'às cegas' where id = v_id and version = 1;
  get diagnostics v_rows = row_count;
  assert v_rows = 0, format('(d) update com versão antiga afetou %s linhas', v_rows);
  assert (select justification from public.proposals where id = v_id) = 'editada', '(d) a linha mudou com a versão antiga';
  update public.proposals set justification = 'certa' where id = v_id and version = 2;
  get diagnostics v_rows = row_count;
  assert v_rows = 1, format('(d) update com versão atual afetou %s linhas', v_rows);
  assert (select version from public.proposals where id = v_id) = 3, '(d) a versão não subiu para 3';
  raise notice '(d) ok: version antiga afeta 0 linhas; a atual afeta 1 e sobe para 3';

  -- (c) raise_proposal_level sobe a versão e grava proposal_level_changes
  insert into public.invoice_audits (invoice_access_key, status, reason) values (repeat('2', 44), 'nao_auditada', 'claude_falhou')
  returning id into v_audit;
  select public.raise_proposal_level(repeat('2', 44), 'diretoria', v_audit) into v_level;
  assert v_level = 'diretoria', format('(c) devolveu %s', v_level);
  assert (select version from public.proposals where id = v_id) = 4, '(c) a versão não subiu para 4';
  assert (select approval_level from public.proposals where id = v_id) = 'diretoria', '(c) o nível não subiu';
  assert (select count(*) from public.proposal_level_changes where proposal_id = v_id and from_level = 'analista' and to_level = 'diretoria') = 1,
    '(c) sem a linha de história';
  raise notice '(c) ok: raise_proposal_level subiu o nível, a versão para 4 e gravou proposal_level_changes';

  -- a guarda da função segue valendo: nível que não sobe não grava nem muda a versão
  select public.raise_proposal_level(repeat('2', 44), 'analista', v_audit) into v_level;
  assert v_level is null and (select version from public.proposals where id = v_id) = 4, 'a guarda da função mudou';
  raise notice 'ok: a guarda da função continua (nível que não sobe devolve null e não muda a versão)';

  -- regra 8: a restrição única de approvals.proposal_id segue decidindo quem chegou antes
  insert into public.approvals (proposal_id, approver, approver_level) values (v_id, 'a@x.test', 'diretoria');
  begin
    insert into public.approvals (proposal_id, approver, approver_level) values (v_id, 'b@x.test', 'diretoria');
    raise exception 'a segunda aprovação entrou';
  exception when unique_violation then
    raise notice 'ok: a segunda aprovação da mesma proposta é recusada (23505)';
  end;

  -- o gatilho não é chamável por anon, authenticated nem public
  assert not has_function_privilege('anon', 'public.proposals_bump_version()', 'execute'), 'anon executa o gatilho';
  assert not has_function_privilege('authenticated', 'public.proposals_bump_version()', 'execute'), 'authenticated executa o gatilho';
end
$$;
SQL

echo "== sem versão repetida"
repetidas="$(ls "$MIGRACOES" | sed 's/_.*//' | sort | uniq -d)"
if [ -n "$repetidas" ]; then echo "versão repetida: $repetidas" >&2; exit 1; fi
echo "OK: todas as migrações aplicadas sem erro, sem versão repetida, e as provas de proposals.version passaram"
