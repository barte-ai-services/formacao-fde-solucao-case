-- #230 A auditoria da nota (agente auditor, #153): só recebe linhas. Cada tentativa é um fato: a auditoria
-- #230 feita, ou "não auditada" com o motivo. Nova tentativa depois de "não auditada" é linha nova, nunca edição.
-- #230 A leitura corrente de uma nota é a auditoria feita, ou a tentativa mais recente (order=status.asc,id.desc&limit=1). RLS ligado e sem política,
-- #230 como em toda tabela: só o Worker lê e grava, com a chave secreta.

create table public.invoice_audits (
  id bigint generated always as identity,
  invoice_access_key text not null,
  status text not null,
  -- #230 Código fechado do motivo (claude_falhou, erro_de_tool, sem_auditoria); nunca o texto de um erro.
  reason text,
  classification text,
  -- #230 A ação na doca que o auditor opina, como {"kind": "receber" | "receber_parcial" | "recusar"}.
  dock_action jsonb,
  routing text,
  justification text,
  amount_at_risk_cents bigint,
  model text,
  audited_at timestamptz,
  -- #230 Em que o auditor difere da proposta da regra; vazio = concorda.
  differing_fields text[],
  -- #230 O nível que o auditor PEDIU para a proposta e o nível que ela tinha quando a nota foi lida; ambos nulos ou ambos
  -- #230 preenchidos. É o pedido, não o fato: a subida aplicada fica em proposal_level_changes (raise_proposal_level).
  requested_level text,
  requested_from_level text,
  -- #230 AC-5: o trecho da nota que dava ordem ao agente (não obedecido).
  injection_flag text,
  -- #230 As recusas do record_audit nesta tentativa, na ordem em que aconteceram (insumo da #154).
  refusals jsonb not null default '[]',
  created_at timestamptz not null default now(),
  constraint invoice_audits_pkey primary key (id),
  constraint invoice_audits_invoice_fkey foreign key (invoice_access_key) references public.invoices (access_key) on delete cascade,
  constraint invoice_audits_status_check check (status in ('audited', 'nao_auditada')),
  constraint invoice_audits_routing_check check (routing is null or routing in ('regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio')),
  constraint invoice_audits_amount_check check (amount_at_risk_cents is null or amount_at_risk_cents >= 0),
  constraint invoice_audits_differing_check check (differing_fields is null or differing_fields <@ array['classification', 'dock_action', 'routing']),
  constraint invoice_audits_requested_level_check check (requested_level is null or requested_level in ('regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio')),
  constraint invoice_audits_requested_from_check check (requested_from_level is null or requested_from_level in ('regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio')),
  constraint invoice_audits_requested_pair_check check ((requested_level is null) = (requested_from_level is null)),
  constraint invoice_audits_injection_check check (injection_flag is null or char_length(injection_flag) <= 500),
  constraint invoice_audits_refusals_check check (jsonb_typeof(refusals) = 'array'),
  -- #230 A forma de cada estado: auditada traz tudo e nenhum motivo; não auditada traz o motivo e nada do resto.
  constraint invoice_audits_shape_check check (
    (status = 'audited'
      and reason is null
      and classification is not null and dock_action is not null and routing is not null
      and justification is not null and model is not null and audited_at is not null
      and differing_fields is not null)
    or
    (status = 'nao_auditada'
      and reason is not null
      and routing is null and differing_fields is null and requested_level is null)
  )
);
alter table public.invoice_audits enable row level security;

-- #230 Só acrescenta: ninguém edita nem apaga uma auditoria. A linha sai só pelo cascade de invoices, que roda
-- #230 como dono da tabela (o reset administrativo apaga a nota).
revoke update on public.invoice_audits from anon, authenticated, service_role;
revoke delete on public.invoice_audits from anon, authenticated, service_role;

-- #230 AC-1: no máximo uma auditoria feita por nota. A violação no insert = "já auditada" (o save vira no-op).
create unique index invoice_audits_audited_key on public.invoice_audits (invoice_access_key) where status = 'audited';
-- #230 A leitura da API (por nota: audited primeiro, depois id desc) e o cascade da chave estrangeira.
create index invoice_audits_key_id_idx on public.invoice_audits (invoice_access_key, id desc);
-- #230 IDX-1: a varredura do reparo (requested_level not null, order=id), só das linhas com nível pedido.
create index invoice_audits_requested_idx on public.invoice_audits (id) where requested_level is not null;

-- #230 PER-3: a história de nível da proposta. Só recebe linhas: cada subida aplicada é um fato, gravada na mesma
-- #230 transação que muda proposals.approval_level (raise_proposal_level). RLS ligado e sem política.
create table public.proposal_level_changes (
  id bigint generated always as identity,
  proposal_id bigint not null,
  from_level text not null,
  to_level text not null,
  invoice_audit_id bigint not null,
  changed_by text not null default 'invoice-audit',
  changed_at timestamptz not null default now(),
  constraint proposal_level_changes_pkey primary key (id),
  constraint proposal_level_changes_proposal_fkey foreign key (proposal_id) references public.proposals (id) on delete cascade,
  constraint proposal_level_changes_audit_fkey foreign key (invoice_audit_id) references public.invoice_audits (id) on delete cascade,
  constraint proposal_level_changes_from_check check (from_level in ('regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio')),
  constraint proposal_level_changes_to_check check (to_level in ('regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio')),
  -- #230 Só sobe: a ordem dos níveis é a da lista.
  constraint proposal_level_changes_rises_check check (
    array_position(array['regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio'], to_level)
    > array_position(array['regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio'], from_level)
  )
);
alter table public.proposal_level_changes enable row level security;
revoke update on public.proposal_level_changes from anon, authenticated, service_role;
revoke delete on public.proposal_level_changes from anon, authenticated, service_role;
-- #230 A história de uma proposta (a mais recente primeiro) e o cascade da chave estrangeira de proposals.
create index proposal_level_changes_proposal_idx on public.proposal_level_changes (proposal_id, id desc);
-- #230 A leitura da API: o nível que a auditoria aplicou (invoice_audit_id = ?, a mais recente) e o cascade da chave de invoice_audits.
create index proposal_level_changes_audit_idx on public.proposal_level_changes (invoice_audit_id, id desc);

-- #230 PER-3: sobe o nível da proposta e grava a história na mesma transação (uma chamada, uma transação). Muda uma raiz
-- #230 (proposals) e a história dela; a guarda é a de antes: só enquanto espera e só para um nível mais alto.
-- #230 Devolve o nível aplicado, ou null quando nada subiu (decidida, já no nível ou acima, ou nível desconhecido).
create function public.raise_proposal_level(p_invoice_access_key text, p_to_level text, p_invoice_audit_id bigint)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_levels constant text[] := array['regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio'];
  v_id bigint;
  v_from text;
begin
  select id, approval_level into v_id, v_from
    from public.proposals
   where invoice_access_key = p_invoice_access_key
     and state = 'aguardando_aprovacao'
     and array_position(v_levels, approval_level) < array_position(v_levels, p_to_level)
     for update;
  if not found then
    return null;
  end if;
  update public.proposals set approval_level = p_to_level where id = v_id;
  insert into public.proposal_level_changes (proposal_id, from_level, to_level, invoice_audit_id)
  values (v_id, v_from, p_to_level, p_invoice_audit_id);
  return p_to_level;
end;
$$;
revoke execute on function public.raise_proposal_level(text, text, bigint) from public, anon, authenticated;
grant execute on function public.raise_proposal_level(text, text, bigint) to service_role;
