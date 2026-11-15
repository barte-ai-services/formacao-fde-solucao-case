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

  it('#230: só acrescenta: UPDATE revogado de anon, authenticated e service_role; RLS ligado, sem política', () => {
    expect(sql).toMatch(/revoke update on public\.invoice_audits from anon, authenticated, service_role/);
    expect(sql).toMatch(/alter table public\.invoice_audits enable row level security/);
    expect(sql).not.toMatch(/create policy/);
  });

  it('#230: a nota apagada leva as auditorias (cascade) e as colunas do desenho existem', () => {
    expect(sql).toMatch(/references public\.invoices \(access_key\) on delete cascade/);
    for (const column of [
      'status', 'reason', 'classification', 'dock_action jsonb', 'routing', 'justification', 'amount_at_risk_cents bigint', 'model',
      'audited_at timestamptz', 'differing_fields text[]', 'raised_level', 'raised_from_level', 'injection_flag',
      "refusals jsonb not null default '[]'", 'created_at timestamptz not null default now()',
    ]) {
      expect(sql).toContain(column);
    }
  });

  it('#230: as formas de cada estado e os limites são checados no banco', () => {
    expect(sql).toMatch(/status in \('audited', 'nao_auditada'\)/);
    expect(sql).toMatch(/\(raised_level is null\) = \(raised_from_level is null\)/);
    expect(sql).toMatch(/char_length\(injection_flag\) <= 500/);
    expect(sql).toMatch(/differing_fields <@ array\['classification', 'dock_action', 'routing'\]/);
    expect(sql).toMatch(/amount_at_risk_cents >= 0/);
  });
});
