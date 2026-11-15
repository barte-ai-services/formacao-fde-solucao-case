-- #230 A auditoria da nota (agente auditor, #153): só recebe linhas. Cada tentativa é um fato: a auditoria
-- #230 feita, ou "não auditada" com o motivo. Nova tentativa depois de "não auditada" é linha nova, nunca edição.
-- #230 A leitura corrente de uma nota é a linha mais recente (order=id.desc&limit=1). RLS ligado e sem política,
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
  -- #230 Nível a que a proposta subiu por esta auditoria e o nível que ela tinha; ambos nulos ou ambos preenchidos.
  raised_level text,
  raised_from_level text,
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
  constraint invoice_audits_raised_level_check check (raised_level is null or raised_level in ('regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio')),
  constraint invoice_audits_raised_from_check check (raised_from_level is null or raised_from_level in ('regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio')),
  constraint invoice_audits_raised_pair_check check ((raised_level is null) = (raised_from_level is null)),
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
      and routing is null and differing_fields is null and raised_level is null)
  )
);
alter table public.invoice_audits enable row level security;

-- #230 Só acrescenta: ninguém edita uma auditoria. DELETE fica só pelo cascade de invoices (reset administrativo).
revoke update on public.invoice_audits from anon, authenticated, service_role;

-- #230 AC-1: no máximo uma auditoria feita por nota. A violação no insert = "já auditada" (o save vira no-op).
create unique index invoice_audits_audited_key on public.invoice_audits (invoice_access_key) where status = 'audited';
-- #230 A leitura da API (linha mais recente por nota), a varredura do nível e o cascade da chave estrangeira.
create index invoice_audits_key_id_idx on public.invoice_audits (invoice_access_key, id desc);
