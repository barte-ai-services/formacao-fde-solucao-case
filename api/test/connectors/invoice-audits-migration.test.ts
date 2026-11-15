/**
 * #230 A migração de invoice_audits, lida como texto: não há Postgres local nesta lane (a prova contra o banco
 * é a do Supabase na aplicação das migrações). Aqui ficam as garantias que a revisão de persistência pediu.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../../../supabase/migrations/20261116110000_invoice_audits.sql', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

describe('migração invoice_audits (#230)', () => {
  it('#230/AC-1: no máximo uma auditoria feita por nota (índice único parcial) e índice da leitura mais recente', () => {
    expect(sql).toMatch(/create unique index invoice_audits_audited_key on public\.invoice_audits \(invoice_access_key\) where status = 'audited'/);
    expect(sql).toMatch(/create index invoice_audits_key_id_idx on public\.invoice_audits \(invoice_access_key, id desc\)/);
  });

  it('#230 IDX-1: a varredura do reparo tem índice parcial próprio, só das linhas com nível elevado', () => {
    expect(sql).toMatch(/create index invoice_audits_requested_idx on public\.invoice_audits \(id\) where requested_level is not null/);
  });

  it('#230: só acrescenta: UPDATE revogado de anon, authenticated e service_role; RLS ligado, sem política', () => {
    expect(sql).toMatch(/revoke update on public\.invoice_audits from anon, authenticated, service_role/);
    expect(sql).toMatch(/revoke delete on public\.invoice_audits from anon, authenticated, service_role/);
    expect(sql).toMatch(/alter table public\.invoice_audits enable row level security/);
    expect(sql).not.toMatch(/create policy/);
  });

  it('#230: a nota apagada leva as auditorias (cascade) e as colunas do desenho existem', () => {
    expect(sql).toMatch(/references public\.invoices \(access_key\) on delete cascade/);
    for (const column of [
      'status', 'reason', 'classification', 'dock_action jsonb', 'routing', 'justification', 'amount_at_risk_cents bigint', 'model',
      'audited_at timestamptz', 'differing_fields text[]', 'requested_level', 'requested_from_level', 'injection_flag',
      "refusals jsonb not null default '[]'", 'created_at timestamptz not null default now()',
    ]) {
      expect(sql).toContain(column);
    }
  });

  it('#230: as formas de cada estado e os limites são checados no banco', () => {
    expect(sql).toMatch(/status in \('audited', 'nao_auditada'\)/);
    expect(sql).toMatch(/\(requested_level is null\) = \(requested_from_level is null\)/);
    expect(sql).toMatch(/char_length\(injection_flag\) <= 500/);
    expect(sql).toMatch(/differing_fields <@ array\['classification', 'dock_action', 'routing'\]/);
    expect(sql).toMatch(/amount_at_risk_cents >= 0/);
  });
});

describe('migração proposal_level_changes e raise_proposal_level (#230 PER-3)', () => {
  it('#230/AC-3: a história de nível só recebe linhas, só sobe, e cada chave estrangeira leva o cascade', () => {
    expect(sql).toMatch(/create table public\.proposal_level_changes/);
    expect(sql).toMatch(/foreign key \(proposal_id\) references public\.proposals \(id\) on delete cascade/);
    expect(sql).toMatch(/foreign key \(invoice_audit_id\) references public\.invoice_audits \(id\) on delete cascade/);
    expect(sql).toMatch(/changed_by text not null default 'invoice-audit'/);
    expect(sql).toMatch(/> array_position\(array\['regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio'\], from_level\)/);
    expect(sql).toMatch(/alter table public\.proposal_level_changes enable row level security/);
    expect(sql).toMatch(/revoke update on public\.proposal_level_changes from anon, authenticated, service_role/);
    expect(sql).toMatch(/revoke delete on public\.proposal_level_changes from anon, authenticated, service_role/);
    expect(sql).toMatch(/create index proposal_level_changes_proposal_idx on public\.proposal_level_changes \(proposal_id, id desc\)/);
    expect(sql).toMatch(/create index proposal_level_changes_audit_idx on public\.proposal_level_changes \(invoice_audit_id, id desc\)/);
  });

  it('#230/AC-3: a função sobe só proposta à espera e abaixo do nível, e grava a história na mesma chamada', () => {
    expect(sql).toMatch(/create function public\.raise_proposal_level\(p_invoice_access_key text, p_to_level text, p_invoice_audit_id bigint\)\s+returns text/);
    expect(sql).toMatch(/set search_path = public/);
    expect(sql).toMatch(/state = 'aguardando_aprovacao'/);
    expect(sql).toMatch(/array_position\(v_levels, approval_level\) < array_position\(v_levels, p_to_level\)/);
    expect(sql).toMatch(/for update/);
    expect(sql).toMatch(/insert into public\.proposal_level_changes/);
  });

  it('#230: só o Worker (service_role) executa a função', () => {
    expect(sql).toMatch(/revoke execute on function public\.raise_proposal_level\(text, text, bigint\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.raise_proposal_level\(text, text, bigint\) to service_role/);
  });
});

