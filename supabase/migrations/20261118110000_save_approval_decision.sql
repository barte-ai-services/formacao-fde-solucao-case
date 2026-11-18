-- #250 #304 A decisão do aprovador numa só transação: aprovação, proposta, título e nota mudam juntos ou nenhum muda.
-- #250 #304 Hoje o Worker faz quatro requisições (uma transação cada); se cai no meio, a aprovação fica gravada com a
-- #250 #304 proposta, o título ou a nota no estado antigo. A função faz tudo numa chamada rpc, como raise_proposal_level.
-- #250 #304 Expandir antes de usar: esta migração só cria a função; o Worker passa a chamá-la no PR seguinte.

-- #250 #304 Devolve 'saved', 'already_decided' (regra 8: quem chega depois perde) ou 'version_conflict' (#295: a
-- #250 #304 proposta mudou desde a leitura). Erro do banco (título ou nota ausente, recusa dos gatilhos do motor em
-- #250 #304 approvals) levanta exceção e desfaz a função inteira. Sem security definer: roda com os direitos de quem chama.
create function public.save_approval_decision(
  p_invoice_access_key text,
  p_version integer,
  p_approver text,
  p_approver_level text,
  p_approval_justification text,
  p_approval_dock_action jsonb,
  p_decided_on date,
  p_approved_at timestamptz,
  p_proposal_state text,
  p_proposal_dock_action jsonb,
  p_proposal_justification text,
  p_title_state text,
  p_title_amount_cents bigint,
  p_title_updated_at timestamptz,
  p_invoice_state text,
  p_engine_decision_id bigint default null,
  p_engine_confidence numeric default null,
  p_engine_model_version text default null
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_id bigint;
  v_version integer;
begin
  -- #304 A mesma trava de linha de raise_proposal_level: as duas funções se serializam sobre a proposta.
  select id, version into v_id, v_version
    from public.proposals
   where invoice_access_key = p_invoice_access_key
     for update;
  if not found then
    raise exception 'proposta da nota % não encontrada', p_invoice_access_key;
  end if;

  -- #304 Regra 8 antes da versão: a primeira decisão sobe a versão, e quem chega depois leu a antiga; ele precisa
  -- #304 receber "já decidida", não "conflito de versão".
  if exists (select 1 from public.approvals where proposal_id = v_id) then
    return 'already_decided';
  end if;

  if v_version <> p_version then
    return 'version_conflict';
  end if;

  -- #304 approved_by é coluna gerada: nunca vai aqui. A restrição única approvals_proposal_key segue como última guarda,
  -- #304 e os gatilhos do motor (23514, 23503, 23505) sobem como erro e desfazem tudo.
  insert into public.approvals (
    proposal_id, approver, approver_level, justification, dock_action, decided_on, approved_at,
    engine_decision_id, engine_confidence, engine_model_version
  ) values (
    v_id, p_approver, p_approver_level, p_approval_justification, p_approval_dock_action, p_decided_on, p_approved_at,
    p_engine_decision_id, p_engine_confidence, p_engine_model_version
  );

  -- #304 O gatilho proposals_bump_version sobe a versão neste update.
  update public.proposals
     set state = p_proposal_state, dock_action = p_proposal_dock_action, justification = p_proposal_justification
   where id = v_id;

  update public.titles
     set state = p_title_state, amount_cents = p_title_amount_cents, updated_at = p_title_updated_at
   where invoice_access_key = p_invoice_access_key;
  if not found then
    raise exception 'título da nota % não encontrado', p_invoice_access_key;
  end if;

  update public.invoices set state = p_invoice_state where access_key = p_invoice_access_key;
  if not found then
    raise exception 'nota % não encontrada', p_invoice_access_key;
  end if;

  return 'saved';
end;
$$;
revoke execute on function public.save_approval_decision(
  text, integer, text, text, text, jsonb, date, timestamptz, text, jsonb, text, text, bigint, timestamptz, text, bigint, numeric, text
) from public, anon, authenticated;
grant execute on function public.save_approval_decision(
  text, integer, text, text, text, jsonb, date, timestamptz, text, jsonb, text, text, bigint, timestamptz, text, bigint, numeric, text
) to service_role;
