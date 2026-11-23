#!/usr/bin/env bash
# #295 Aplica TODAS as migrações de supabase/migrations/ num Postgres de verdade (docker, descartável) e prova a
# trava otimista de proposals.version. Fora do `make check`: o CI não tem docker garantido. Reexecutável.
# #304 Prova também a função save_approval_decision (a decisão do aprovador numa só transação).
# #349 Prova também kit_insert_demo_batch (o lote de notas da demonstração numa só chamada) e a coluna kit_notas.origin.
# #353 Prova também a devolução automática: demo_auto_return_pending e demo_auto_return_send (emite, envia e move a fila numa transação).
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

echo "== provas da função save_approval_decision (#304)"
psql <<'SQL'
\set QUIET off
-- #304 Ajudantes da sessão (somem com ela): uma nota completa (nota, proposta, título), o snapshot das quatro tabelas
-- #304 de uma nota, e a chamada da função com os campos que o Worker manda.
create function pg_temp.new_invoice(p_key text, p_level text default 'analista') returns bigint language plpgsql as $f$
declare v_id bigint;
begin
  insert into public.invoices (access_key, number, series, supplier_id, store, issued_on, entry_channel, total_cents, items, state)
  values (p_key, '9', '1', 'F1', 'L1', '2026-11-18', 'sefaz', 1000, '[]', 'com_proposta');
  insert into public.proposals (invoice_access_key, classification, dock_action, approval_level, amount_at_risk_cents, justification, state)
  values (p_key, 'E4', '{"kind":"receber"}', p_level, 0, 'antes', 'aguardando_aprovacao') returning id into v_id;
  insert into public.titles (invoice_access_key, amount_cents, due_on) values (p_key, 1000, '2026-12-18');
  return v_id;
end $f$;

create function pg_temp.snapshot(p_key text) returns jsonb language sql as $f$
  select jsonb_build_object(
    'invoice', (select to_jsonb(i) from public.invoices i where i.access_key = p_key),
    'proposal', (select to_jsonb(p) from public.proposals p where p.invoice_access_key = p_key),
    'title', (select to_jsonb(t) from public.titles t where t.invoice_access_key = p_key),
    'approvals', (select coalesce(jsonb_agg(to_jsonb(a)), '[]') from public.approvals a
                   join public.proposals p on p.id = a.proposal_id where p.invoice_access_key = p_key))
$f$;

create function pg_temp.decide(p_key text, p_version integer, p_approver text default 'diretoria@x.test', p_level text default 'diretoria',
                                p_engine bigint default null, p_confidence numeric default null, p_model text default null)
returns text language sql as $f$
  select public.save_approval_decision(
    p_key, p_version, p_approver, p_level, 'ok', '{"kind":"receber"}', '2026-11-18', now(),
    'aprovada', '{"kind":"receber"}', 'ok', 'liberado', 900, now(), 'decidida',
    p_engine, p_confidence, p_model)
$f$;

do $$
declare
  v_id bigint;
  v_before jsonb;
  v_after jsonb;
  v_ret text;
  v_eng bigint;
begin
  -- (1) decisão válida: devolve saved, grava as quatro tabelas e sobe a versão
  v_id := pg_temp.new_invoice(repeat('3', 44));
  v_ret := pg_temp.decide(repeat('3', 44), 1);
  assert v_ret = 'saved', format('(1) devolveu %s', v_ret);
  v_after := pg_temp.snapshot(repeat('3', 44));
  assert (v_after #>> '{proposal,state}') = 'aprovada' and (v_after #>> '{proposal,version}')::int = 2, '(1) proposta';
  assert (v_after #>> '{title,state}') = 'liberado' and (v_after #>> '{title,amount_cents}')::int = 900, '(1) título';
  assert (v_after #>> '{invoice,state}') = 'decidida', '(1) nota';
  assert jsonb_array_length(v_after -> 'approvals') = 1 and (v_after #>> '{approvals,0,approved_by}') = 'person', '(1) aprovação';
  raise notice '(1) ok: decisão válida gravou aprovação, proposta, título e nota, e subiu a versão para 2';

  -- (2) a segunda chamada, mesmo com a versão antiga (1): already_decided e nada muda
  v_before := pg_temp.snapshot(repeat('3', 44));
  v_ret := pg_temp.decide(repeat('3', 44), 1, 'outra@x.test');
  assert v_ret = 'already_decided', format('(2) devolveu %s', v_ret);
  assert pg_temp.snapshot(repeat('3', 44)) = v_before, '(2) a segunda chamada mudou alguma tabela';
  raise notice '(2) ok: segunda decisão (versão antiga) devolveu already_decided e nada mudou';

  -- (3) versão antiga numa proposta ainda sem decisão: version_conflict e nada muda (nem a aprovação)
  v_id := pg_temp.new_invoice(repeat('4', 44));
  update public.proposals set justification = 'mudou' where id = v_id;
  v_before := pg_temp.snapshot(repeat('4', 44));
  v_ret := pg_temp.decide(repeat('4', 44), 1);
  assert v_ret = 'version_conflict', format('(3) devolveu %s', v_ret);
  assert pg_temp.snapshot(repeat('4', 44)) = v_before, '(3) o conflito mudou alguma tabela';
  assert jsonb_array_length(v_before -> 'approvals') = 0, '(3) havia aprovação';
  raise notice '(3) ok: versão antiga devolveu version_conflict e nada foi gravado';

  -- (4) título ausente: levanta erro, e aprovação, proposta e nota ficam como estavam
  v_id := pg_temp.new_invoice(repeat('5', 44));
  delete from public.titles where invoice_access_key = repeat('5', 44);
  v_before := pg_temp.snapshot(repeat('5', 44));
  begin
    perform pg_temp.decide(repeat('5', 44), 1);
    raise exception '(4) a decisão sem título entrou';
  exception when raise_exception then
    if sqlerrm not like '%título da nota%' then raise; end if;
  end;
  assert pg_temp.snapshot(repeat('5', 44)) = v_before, '(4) a falha no título deixou rastro';
  raise notice '(4) ok: título ausente levantou erro e aprovação, proposta e nota ficaram como estavam';

  -- (4b) proposta (e com ela a nota) ausente: levanta erro e nada é gravado
  begin
    perform pg_temp.decide(repeat('9', 44), 1);
    raise exception '(4b) a decisão sem proposta entrou';
  exception when raise_exception then
    if sqlerrm not like '%proposta da nota%' then raise; end if;
  end;
  assert not exists (select 1 from public.approvals a join public.proposals p on p.id = a.proposal_id where p.invoice_access_key = repeat('9', 44)),
    '(4b) aprovação gravada';
  raise notice '(4b) ok: nota sem proposta levantou erro e nada foi gravado (título sem nota não existe: a chave estrangeira garante, então o erro da nota ausente cai aqui)';

  -- (5) aprovação do motor que o gatilho recusa (delegação desligada: 23514) levanta erro e nada fica gravado
  v_id := pg_temp.new_invoice(repeat('6', 44));
  insert into public.engine_decisions (proposal_id, invoice_access_key, outcome, decided_by, model_version, mode, reason)
  values (v_id, repeat('6', 44), 'approve', 'rule', 'regra-e4-v1', 'delegated', 'prova') returning id into v_eng;
  update public.engine_settings set delegation_enabled = false where level = 'analista';
  v_before := pg_temp.snapshot(repeat('6', 44));
  begin
    perform pg_temp.decide(repeat('6', 44), 1, 'motor', 'analista', v_eng, null, 'regra-e4-v1');
    raise exception '(5) o gatilho do motor não recusou';
  exception when check_violation then
    raise notice '(5) recusa do gatilho: %', sqlerrm;
  end;
  assert pg_temp.snapshot(repeat('6', 44)) = v_before, '(5) a recusa do gatilho deixou rastro';
  raise notice '(5) ok: aprovação do motor recusada pelo gatilho (23514) levantou erro e nada ficou gravado';

  -- (5b) com a delegação ligada, a mesma aprovação do motor entra, pela mesma função (e approved_by sai gerada: engine)
  update public.engine_settings set delegation_enabled = true where level = 'analista';
  v_ret := pg_temp.decide(repeat('6', 44), 1, 'motor', 'analista', v_eng, null, 'regra-e4-v1');
  update public.engine_settings set delegation_enabled = false where level = 'analista';
  assert v_ret = 'saved', format('(5b) devolveu %s', v_ret);
  assert (pg_temp.snapshot(repeat('6', 44)) #>> '{approvals,0,approved_by}') = 'engine', '(5b) approved_by não é engine';
  raise notice '(5b) ok: com a delegação ligada a aprovação do motor grava as quatro tabelas, approved_by = engine';

  -- (7) versão nula: a função se guarda sozinha, levanta erro e nada é gravado (um `<>` com nulo pularia a conferência)
  v_id := pg_temp.new_invoice(repeat('7', 44));
  update public.proposals set justification = 'mudou' where id = v_id;
  v_before := pg_temp.snapshot(repeat('7', 44));
  begin
    perform pg_temp.decide(repeat('7', 44), null);
    raise exception '(7) a decisão com versão nula entrou';
  exception when raise_exception then
    if sqlerrm like '(7)%' or sqlerrm not like '%versão lida%' then raise; end if;
  end;
  assert pg_temp.snapshot(repeat('7', 44)) = v_before, '(7) a versão nula deixou rastro';
  raise notice '(7) ok: p_version nulo levantou erro e nada foi gravado';

  -- (6) permissões: só o service_role executa
  assert not has_function_privilege('anon', 'public.save_approval_decision(text,integer,text,text,text,jsonb,date,timestamptz,text,jsonb,text,text,bigint,timestamptz,text,bigint,numeric,text)', 'execute'), 'anon executa';
  assert not has_function_privilege('authenticated', 'public.save_approval_decision(text,integer,text,text,text,jsonb,date,timestamptz,text,jsonb,text,text,bigint,timestamptz,text,bigint,numeric,text)', 'execute'), 'authenticated executa';
  assert has_function_privilege('service_role', 'public.save_approval_decision(text,integer,text,text,text,jsonb,date,timestamptz,text,jsonb,text,text,bigint,timestamptz,text,bigint,numeric,text)', 'execute'), 'service_role não executa';
  raise notice '(6) ok: anon e authenticated sem execute; service_role com';
end
$$;
SQL

echo "== #311 o backfill do dossiê e o estado dos pedidos (a linha (e) já existia, aguardando_aprovacao, rota analista)"
psql <<'SQL'
do $$
declare
  v_status text;
begin
  select status into v_status from public.dossier_requests where input_key = repeat('1', 44) and requested_by = 'backfill';
  assert v_status = 'pending', format('(#311) a proposta antiga deveria estar pending, está %s', v_status);
end
$$;
SQL
psql -f - < "$MIGRACOES/20261122110000_dossier_backfill.sql"
psql <<'SQL'
do $$
begin
  assert (select count(*) from public.dossier_requests where input_key = repeat('1', 44) and status = 'pending') = 1, '(#311) o backfill repetido duplicou o pendente';
  -- o estado done grava, e o motivo fora do conjunto fechado é recusado
  insert into public.dossier_requests (input_key, requested_by, finished_at, status) values (repeat('2', 44), 'x', now(), 'done');
  assert (select status from public.dossier_requests where input_key = repeat('2', 44)) = 'done', '(#311) status done não gravou';
  begin
    insert into public.dossier_requests (input_key, requested_by, status, reason) values (repeat('3', 44), 'x', 'error', 'texto livre');
    raise exception '(#311) motivo fora do conjunto fechado entrou';
  exception when check_violation then null;
  end;
  raise notice '(#311) ok: o backfill enfileirou a proposta antiga como pending, é idempotente, e o motivo é um conjunto fechado';
end
$$;
SQL

echo "== #311 o backfill não enfileira a nota de dossiê esgotado, e os índices do dossiê existem"
psql <<'SQL'
insert into public.invoices (access_key, number, series, supplier_id, store, issued_on, entry_channel, total_cents, items, state)
values (repeat('9', 44), '9', '1', 'F1', 'L1', '2026-11-18', 'sefaz', 1000, '[]', 'com_proposta');
insert into public.proposals (invoice_access_key, classification, dock_action, approval_level, amount_at_risk_cents, justification, state)
values (repeat('9', 44), 'E5', '{"kind":"receber"}', 'analista', 0, 'esgotada', 'aguardando_aprovacao');
insert into public.claude_suggestions (task, input_key, input, status, model, error, attempts)
values ('dossier', repeat('9', 44), '{}', 'error', 'm', 'x', 3);
SQL
psql -f - < "$MIGRACOES/20261122110000_dossier_backfill.sql"
psql <<'SQL'
do $$
begin
  assert (select count(*) from public.dossier_requests where input_key = repeat('9', 44)) = 0, '(#311) o backfill enfileirou a nota de dossiê esgotado';
  assert (select count(*) from public.dossier_requests where input_key = repeat('1', 44) and status = 'pending') = 1, '(#311) o backfill perdeu o pendente da nota que ainda pode gerar';
  assert exists (select 1 from pg_indexes where indexname = 'dossier_requests_requested_at_idx'), '(#311) falta o índice de requested_at';
  assert exists (select 1 from pg_indexes where indexname = 'dossier_requests_open_requested_at_idx' and indexdef like '%WHERE%'), '(#311) falta o índice parcial de pending e error';
  raise notice '(#311) ok: nota esgotada fora do backfill; índices de dossier_requests criados';
end
$$;
SQL

echo "== provas da função kit_insert_demo_batch e da coluna kit_notas.origin (#349)"
psql <<'SQL'
\set QUIET off
do $$
declare
  v_batch jsonb;
  v_n integer;
  v_before integer;
begin
  -- o cadastro que o lote cita (a carga do kit o traz em produção)
  insert into public.kit_fornecedores (fornecedor_id, razao_social, cnpj, bloqueado, motivo_bloqueio)
  values ('F01', 'Fornecedor de teste', '00.000.000/0001-00', false, '');
  insert into public.kit_produtos (sku, descricao, fornecedor_id, codigo_fornecedor, unidade_base, fator_caixa, preco_referencia_un)
  values ('SKU-1', 'Produto de teste', 'F01', 'F01-001', 'UN', 4, 10.00);

  -- (a) a nota que entra sem dizer a origem é da base; a origem só aceita base ou demo
  insert into public.kit_notas (chave, nota_id, numero, serie, fornecedor_id, destino, data_emissao, pedido_referenciado, canal_entrada, valor_total)
  values (repeat('0', 44), 'NF-001', 1, 1, 'F01', 'LJ-001', '2026-11-23', null, 'SEFAZ', 40.00);
  assert (select origin from public.kit_notas where chave = repeat('0', 44)) = 'base', '(a) a nota sem origem não ficou base';
  begin
    update public.kit_notas set origin = 'real' where chave = repeat('0', 44);
    raise exception '(a) origin = real entrou';
  exception when check_violation then
    null;
  end;
  raise notice '(a) ok: origin vale base por padrão e só aceita base ou demo';

  -- (b) um lote de duas notas, com ordem, recebimento e pagamento: grava tudo e devolve 2
  v_batch := jsonb_build_object(
    'kit_ordens', jsonb_build_array(jsonb_build_object('ordem_id', 'OC-DM-1', 'fornecedor_id', 'F01', 'destino', 'LJ-001',
      'data_emissao', '2026-11-20', 'status', 'aberta', 'motivo_status', '', 'valor_total', 40.00)),
    'kit_ordem_itens', jsonb_build_array(jsonb_build_object('ordem_id', 'OC-DM-1', 'codigo_fornecedor', 'F01-001', 'sku', 'SKU-1',
      'descricao', 'Produto de teste', 'quantidade', 4, 'unidade', 'UN', 'preco_unitario', 10.00)),
    'kit_notas', jsonb_build_array(
      jsonb_build_object('chave', repeat('1', 44), 'nota_id', 'DM-00001', 'numero', 10, 'serie', 1, 'fornecedor_id', 'F01', 'destino', 'LJ-001',
        'data_emissao', '2026-11-23', 'pedido_referenciado', 'OC-DM-1', 'canal_entrada', 'SEFAZ', 'valor_total', 40.00, 'origin', 'base'),
      jsonb_build_object('chave', repeat('2', 44), 'nota_id', 'DM-00002', 'numero', 11, 'serie', 1, 'fornecedor_id', 'F01', 'destino', 'LJ-001',
        'data_emissao', '2026-11-23', 'pedido_referenciado', null, 'canal_entrada', 'e-mail', 'valor_total', 40.00)),
    'kit_nota_itens', jsonb_build_array(
      jsonb_build_object('chave', repeat('1', 44), 'codigo_fornecedor', 'F01-001', 'sku', 'SKU-1', 'descricao', 'Produto de teste',
        'quantidade', 4, 'unidade', 'UN', 'preco_unitario', 10.00, 'valor', 40.00),
      jsonb_build_object('chave', repeat('2', 44), 'codigo_fornecedor', 'F01-001', 'sku', 'SKU-1', 'descricao', 'Produto de teste',
        'quantidade', 4, 'unidade', 'UN', 'preco_unitario', 10.00, 'valor', 40.00)),
    'kit_recebimentos', jsonb_build_array(jsonb_build_object('recebimento_id', 'RC-DM-1', 'nota_chave', repeat('1', 44), 'ordem_id', 'OC-DM-1',
      'fornecedor_id', 'F01', 'destino', 'LJ-001', 'canal', 'app_loja', 'data', '2026-11-23', 'observacao', '')),
    'kit_recebimento_itens', jsonb_build_array(jsonb_build_object('recebimento_id', 'RC-DM-1', 'codigo_fornecedor', 'F01-001',
      'descricao', 'Produto de teste', 'quantidade', 4, 'unidade', 'UN')),
    'kit_pagamentos', jsonb_build_array(jsonb_build_object('pagamento_id', 'PG-DM-1', 'fornecedor_id', 'F01', 'destino', 'LJ-001',
      'data', '2026-11-20', 'valor', 40.00, 'forma', 'pix', 'origem', 'compra emergencial da loja, fora do fluxo', 'nota_chave', null)));
  v_n := public.kit_insert_demo_batch(v_batch);
  assert v_n = 2, format('(b) devolveu %s, esperado 2', v_n);
  assert (select count(*) from public.kit_notas where origin = 'demo') = 2, '(b) as duas notas não são demo';
  assert (select count(*) from public.kit_nota_itens where chave in (repeat('1', 44), repeat('2', 44))) = 2, '(b) itens da nota';
  assert (select count(*) from public.kit_ordens where ordem_id = 'OC-DM-1') = 1, '(b) ordem';
  assert (select count(*) from public.kit_recebimentos where recebimento_id = 'RC-DM-1') = 1, '(b) recebimento';
  assert (select count(*) from public.kit_pagamentos where pagamento_id = 'PG-DM-1') = 1, '(b) pagamento';
  assert (select origin from public.kit_notas where chave = repeat('0', 44)) = 'base', '(b) a nota da base mudou de origem';
  raise notice '(b) ok: o lote de duas notas gravou as tabelas e devolveu 2; a origem vem da função, não do lote (origin base no lote virou demo)';

  -- (c) repetir o lote não duplica nem apaga nada: devolve 0
  v_before := (select count(*) from public.kit_nota_itens);
  v_n := public.kit_insert_demo_batch(v_batch);
  assert v_n = 0, format('(c) devolveu %s, esperado 0', v_n);
  assert (select count(*) from public.kit_notas) = 3 and (select count(*) from public.kit_nota_itens) = v_before, '(c) repetir mudou as linhas';
  raise notice '(c) ok: o mesmo lote de novo devolve 0 e não duplica nem apaga nada';

  -- (d) lote com uma nota de fornecedor inexistente: levanta erro e nada do lote fica (uma transação só)
  v_batch := jsonb_build_object(
    'kit_ordens', jsonb_build_array(jsonb_build_object('ordem_id', 'OC-DM-9', 'fornecedor_id', 'F01', 'destino', 'LJ-001',
      'data_emissao', '2026-11-20', 'status', 'aberta', 'motivo_status', '', 'valor_total', 40.00)),
    'kit_notas', jsonb_build_array(jsonb_build_object('chave', repeat('9', 44), 'nota_id', 'DM-00009', 'numero', 99, 'serie', 1,
      'fornecedor_id', 'F99', 'destino', 'LJ-001', 'data_emissao', '2026-11-23', 'pedido_referenciado', null,
      'canal_entrada', 'SEFAZ', 'valor_total', 1.00)));
  begin
    perform public.kit_insert_demo_batch(v_batch);
    raise exception '(d) o lote com fornecedor inexistente entrou';
  exception when foreign_key_violation then
    null;
  end;
  assert not exists (select 1 from public.kit_ordens where ordem_id = 'OC-DM-9'), '(d) a ordem do lote que falhou ficou gravada';
  raise notice '(d) ok: lote com nota inválida levantou erro e nenhuma linha dele ficou';

  -- (e) lote ausente ou fora do formato
  begin
    perform public.kit_insert_demo_batch(null);
    raise exception '(e) lote nulo entrou';
  exception when raise_exception then
    if sqlerrm like '(e)%' then raise; end if;
  end;
  begin
    perform public.kit_insert_demo_batch('[]'::jsonb);
    raise exception '(e) lote em lista entrou';
  exception when raise_exception then
    if sqlerrm like '(e)%' then raise; end if;
  end;
  raise notice '(e) ok: lote nulo ou fora do formato levanta erro';

  -- (f) permissões: só o service_role executa
  assert not has_function_privilege('anon', 'public.kit_insert_demo_batch(jsonb)', 'execute'), '(f) anon executa';
  assert not has_function_privilege('authenticated', 'public.kit_insert_demo_batch(jsonb)', 'execute'), '(f) authenticated executa';
  assert has_function_privilege('service_role', 'public.kit_insert_demo_batch(jsonb)', 'execute'), '(f) service_role não executa';
  raise notice '(f) ok: anon e authenticated sem execute; service_role com';

  -- (g) a carga da base (upsert pela chave) não apaga a nota de demonstração e deixa a da base como base
  insert into public.kit_notas (chave, nota_id, numero, serie, fornecedor_id, destino, data_emissao, pedido_referenciado, canal_entrada, valor_total, origin)
  values (repeat('0', 44), 'NF-001', 1, 1, 'F01', 'LJ-001', '2026-11-23', null, 'SEFAZ', 40.00, 'base')
  on conflict (chave) do update set nota_id = excluded.nota_id, origin = excluded.origin;
  assert (select count(*) from public.kit_notas where origin = 'demo') = 2, '(g) a carga apagou nota de demonstração';
  raise notice '(g) ok: o upsert da base deixa as notas de demonstração como estavam';
end
$$;
SQL

echo "== provas da devolução automática (#353): demo_auto_return_pending e demo_auto_return_send"
psql <<'SQL'
do $$
declare
  v_pending jsonb;
  v_batch jsonb;
  v_note jsonb;
  v_n integer;
  v_q1 bigint;
  v_q2 bigint;
  v_q3 bigint;
  v_req bigint;
  v_issued bigint;
  v_row record;
begin
  -- o cadastro: o fornecedor F01 passa a ter e-mail; as notas 'a' e 'b' (demo) e 'c' (base) existem em kit_notas e em invoices
  update public.kit_fornecedores set email = 'compras@fornecedor.example' where fornecedor_id = 'F01';
  insert into public.kit_notas (chave, nota_id, numero, serie, fornecedor_id, destino, data_emissao, pedido_referenciado, canal_entrada, valor_total, origin)
  values (repeat('a', 44), 'DM-00006', 16, 1, 'F01', 'LJ-001', '2026-11-23', null, 'SEFAZ', 40.00, 'demo'),
         (repeat('b', 44), 'DM-00007', 17, 1, 'F01', 'LJ-001', '2026-11-23', null, 'SEFAZ', 40.00, 'demo'),
         (repeat('c', 44), 'NF-008', 8, 1, 'F01', 'LJ-001', '2026-11-23', null, 'SEFAZ', 40.00, 'base');
  insert into public.invoices (access_key, number, series, supplier_id, store, issued_on, entry_channel, total_cents, items, state)
  select k, n, '1', 'F01', 'LJ-001', '2026-11-23', 'sefaz', 100000,
    '[{"supplierCode":"F01-001","sku":"SKU-1","description":"Produto de teste","quantity":{"amount":100,"unit":"UN"},"unitPriceCents":10000,"totalCents":1000000}]'::jsonb, 'decidida'
  from (values (repeat('a', 44), '10'), (repeat('b', 44), '11'), (repeat('c', 44), '88')) t(k, n);
  -- três devoluções pendentes: 3 UN (R$ 300,00) de nota demo, 60 UN (R$ 6.000,00) de nota demo e 3 UN de nota da base
  insert into public.outbox_return_notes (invoice_access_key, payload, idempotency_key) values
    (repeat('a', 44), '{"lines":[{"supplierCode":"F01-001","amount":3,"unit":"UN"}],"reason":"x"}', 'k-a'),
    (repeat('b', 44), '{"lines":[{"supplierCode":"F01-001","amount":60,"unit":"UN"}],"reason":"x"}', 'k-b'),
    (repeat('c', 44), '{"lines":[{"supplierCode":"F01-001","amount":3,"unit":"UN"}],"reason":"x"}', 'k-c');
  v_q1 := (select id from public.outbox_return_notes where invoice_access_key = repeat('a', 44));
  v_q2 := (select id from public.outbox_return_notes where invoice_access_key = repeat('b', 44));
  v_q3 := (select id from public.outbox_return_notes where invoice_access_key = repeat('c', 44));

  -- (a) modo desligado: nada para ler nem para enviar, qualquer que seja o limite
  update public.demo_settings set enabled = false;
  v_pending := public.demo_auto_return_pending();
  assert jsonb_array_length(v_pending -> 'entries') = 0, '(a) leu entrada com o modo desligado';
  update public.demo_settings set enabled = true;

  -- (b) modo ligado, limite padrão R$ 5.000,00: só a de R$ 300,00 da nota demo (a de R$ 6.000,00 passa do limite, a da base não é demo)
  v_pending := public.demo_auto_return_pending();
  assert (v_pending ->> 'limitCents')::integer = 500000, '(b) o limite padrão não é 500000';
  assert jsonb_array_length(v_pending -> 'entries') = 1, format('(b) esperava 1 entrada, veio %s', jsonb_array_length(v_pending -> 'entries'));
  assert (v_pending -> 'entries' -> 0 ->> 'queueId')::bigint = v_q1, '(b) a entrada não é a de R$ 300,00';
  assert (v_pending -> 'entries' -> 0 ->> 'supplierEmail') = 'compras@fornecedor.example', '(b) e-mail do fornecedor';
  assert (v_pending -> 'entries' -> 0 -> 'request') = 'null'::jsonb, '(b) não havia rascunho';
  raise notice '(b) ok: só a devolução de nota demo até o limite é lida';

  -- (c) o limite muda no banco, sem deploy: com R$ 10.000,00 a de R$ 6.000,00 entra, com zero nada entra
  update public.demo_settings set auto_return_limit_cents = 1000000;
  assert jsonb_array_length(public.demo_auto_return_pending() -> 'entries') = 2, '(c) com R$ 10.000,00 deveriam ser 2';
  update public.demo_settings set auto_return_limit_cents = 0;
  assert jsonb_array_length(public.demo_auto_return_pending() -> 'entries') = 0, '(c) com limite zero nada deveria entrar';
  begin
    update public.demo_settings set auto_return_limit_cents = -1;
    raise exception '(c) limite negativo entrou';
  exception when check_violation then null;
  end;
  update public.demo_settings set auto_return_limit_cents = 500000;
  raise notice '(c) ok: o limite vem do banco, zero desliga e negativo não existe';

  -- (d) enviar: a nota é emitida, o pedido sai como enviado pela automação (origin demo) e a fila vai para emitida, tudo junto
  v_note := '{"nature":"devolucao","referencedAccessKey":"x","supplierId":"F01","destination":"LJ-001","items":[],"total":300}'::jsonb;
  v_batch := jsonb_build_array(jsonb_build_object(
    'queueId', v_q1, 'invoiceAccessKey', repeat('a', 44), 'supplierId', 'F01', 'recipient', 'compras@fornecedor.example', 'note', v_note,
    'subject', 'Devolução da nota {{nota.numero}}', 'body', 'corpo', 'asks', jsonb_build_array('a'), 'issuedOn', '2026-11-23',
    'draftedOn', '2026-11-23', 'dueOn', '2026-11-26', 'requestId', null, 'requestVersion', null));
  v_n := public.demo_auto_return_send(v_batch);
  assert v_n = 1, format('(d) devolveu %s, esperado 1', v_n);
  v_issued := (select id from public.issued_return_notes where queue_id = v_q1);
  assert v_issued is not null, '(d) a nota não foi emitida';
  select * into v_row from public.outbox_supplier_emails where queue_id = v_q1;
  assert v_row.status = 'sent' and v_row.origin = 'demo' and v_row.sent_by = 'automação' and v_row.channel = 'mock', '(d) o pedido não saiu como enviado pela automação';
  assert v_row.issued_return_note_id = v_issued and v_row.version = 1 and jsonb_array_length(v_row.history) = 1, '(d) nota, versão ou histórico do pedido';
  assert (v_row.history -> 0 ->> 'by') = 'automação' and (v_row.history -> 0 ->> 'action') = 'sent', '(d) a entrada do histórico';
  assert (v_row.attachments -> 0 ->> 'filename') = 'nota-devolucao-ND-' || v_issued || '.json', '(d) o anexo aponta a nota emitida';
  select * into v_row from public.outbox_return_notes where id = v_q1;
  assert v_row.status = 'emitida' and v_row.emitted_by = 'automação' and v_row.nfe_number = v_issued::text, '(d) a fila não foi movida para emitida pela automação';
  assert (select status from public.outbox_return_notes where id = v_q2) = 'pendente', '(d) a outra devolução mudou';
  raise notice '(d) ok: emitiu a nota, enviou o pedido (origin demo, sent_by automação) e moveu a fila numa chamada';

  -- (e) repetir o lote não emite de novo nem duplica: a devolução já não está pendente
  assert public.demo_auto_return_send(v_batch) = 0, '(e) repetir o lote devolveu mais que 0';
  assert (select count(*) from public.issued_return_notes where queue_id = v_q1) = 1, '(e) emitiu a nota duas vezes';
  assert (select count(*) from public.outbox_supplier_emails where queue_id = v_q1) = 1, '(e) duplicou o pedido';
  raise notice '(e) ok: o mesmo lote de novo devolve 0 e não duplica nada';

  -- (f) o banco confere o limite e a origem de novo: lote com nota acima do limite, ou de nota da base, não passa
  update public.demo_settings set auto_return_limit_cents = 10000;
  assert public.demo_auto_return_send(jsonb_set(jsonb_set(v_batch, '{0,queueId}', to_jsonb(v_q2)), '{0,invoiceAccessKey}', to_jsonb(repeat('b', 44)))) = 0, '(f) enviou acima do limite';
  update public.demo_settings set auto_return_limit_cents = 500000;
  assert public.demo_auto_return_send(jsonb_set(jsonb_set(v_batch, '{0,queueId}', to_jsonb(v_q3)), '{0,invoiceAccessKey}', to_jsonb(repeat('c', 44)))) = 0, '(f) enviou nota da base';
  assert (select status from public.outbox_return_notes where id in (v_q2, v_q3) and status <> 'pendente' limit 1) is null, '(f) moveu a fila que não devia';
  update public.demo_settings set enabled = false;
  assert public.demo_auto_return_send(v_batch) = 0, '(f) enviou com o modo desligado';
  update public.demo_settings set enabled = true;
  raise notice '(f) ok: acima do limite, nota da base ou modo desligado não saem';

  -- (g) o rascunho que já existia (o do Claude) é o que sai: mesmo texto, versão sobe, origin vira demo
  insert into public.outbox_supplier_emails (invoice_access_key, queue_id, supplier_id, request_type, recipient, subject, body, asks, note, drafted_on, due_on, model, status, history)
  values (repeat('b', 44), v_q2, 'F01', 'return_note', 'compras@fornecedor.example', 'Assunto do Claude', 'Corpo do Claude', '["pedido"]', v_note, '2026-11-23', '2026-11-26', 'claude', 'draft',
    '[{"version":1,"at":"2026-11-23T10:00:00Z","by":"agente","action":"drafted","state":{}}]');
  v_req := (select id from public.outbox_supplier_emails where queue_id = v_q2);
  update public.demo_settings set auto_return_limit_cents = 1000000;
  v_pending := public.demo_auto_return_pending();
  assert (v_pending -> 'entries' -> 0 -> 'request' ->> 'id')::bigint = v_req and (v_pending -> 'entries' -> 0 -> 'request' ->> 'subject') = 'Assunto do Claude', '(g) a leitura não trouxe o rascunho';
  v_batch := jsonb_build_array(jsonb_build_object(
    'queueId', v_q2, 'invoiceAccessKey', repeat('b', 44), 'supplierId', 'F01', 'recipient', 'compras@fornecedor.example',
    'note', jsonb_set(v_note, '{total}', '6000'), 'subject', 'Assunto do Claude', 'body', 'Corpo do Claude', 'asks', jsonb_build_array('pedido'),
    'issuedOn', '2026-11-23', 'draftedOn', '2026-11-23', 'dueOn', '2026-11-26', 'requestId', v_req, 'requestVersion', 1));
  assert public.demo_auto_return_send(v_batch) = 1, '(g) o rascunho não saiu';
  select * into v_row from public.outbox_supplier_emails where id = v_req;
  assert v_row.status = 'sent' and v_row.origin = 'demo' and v_row.sent_by = 'automação' and v_row.version = 2 and v_row.subject = 'Assunto do Claude', '(g) o rascunho não virou enviado';
  assert jsonb_array_length(v_row.history) = 2, '(g) o histórico não ganhou a entrada do envio';
  assert (select count(*) from public.outbox_supplier_emails where queue_id = v_q2) = 1, '(g) criou um segundo pedido';
  -- e a versão velha é pulada: o lote com a versão 1 de novo não acha a fila pendente nem o rascunho
  assert public.demo_auto_return_send(v_batch) = 0, '(g) reenviou o rascunho já enviado';
  update public.demo_settings set auto_return_limit_cents = 500000;
  raise notice '(g) ok: o rascunho do Claude sai com o texto dele, na versão seguinte, e o lote velho é pulado';

  -- (h) permissões: só o service_role executa as duas funções
  assert not has_function_privilege('anon', 'public.demo_auto_return_pending()', 'execute'), '(h) anon executa a leitura';
  assert not has_function_privilege('authenticated', 'public.demo_auto_return_send(jsonb)', 'execute'), '(h) authenticated executa o envio';
  assert has_function_privilege('service_role', 'public.demo_auto_return_pending()', 'execute') and has_function_privilege('service_role', 'public.demo_auto_return_send(jsonb)', 'execute'), '(h) service_role sem execute';
  raise notice '(h) ok: só o service_role executa';
end
$$;
SQL

echo "== sem versão repetida"
repetidas="$(ls "$MIGRACOES" | sed 's/_.*//' | sort | uniq -d)"
if [ -n "$repetidas" ]; then echo "versão repetida: $repetidas" >&2; exit 1; fi
echo "OK: todas as migrações aplicadas sem erro, sem versão repetida, e as provas de proposals.version, de save_approval_decision, de kit_insert_demo_batch e da devolução automática (#353) passaram"
