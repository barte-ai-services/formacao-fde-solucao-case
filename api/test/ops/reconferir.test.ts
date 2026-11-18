import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { DOMAIN_TABLES, reconferir, resetDomain } from '../../src/ops/reconferir.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

// #56 Reconferir sobre a base do kit num PostgREST falso.

function setup() {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { captureDeps } = supabaseConnectors(rest);
  const runOnce = async () => {
    await captureInvoices(captureDeps);
    await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry });
  };
  return { fake, rest, runOnce };
}

const kitCounts = (fake: FakePostgrest) =>
  Object.fromEntries(Object.keys(kitTables()).map((t) => [t, fake.rows(t).length]));

describe('#56 reconferir', () => {
  it('apaga todas as tabelas do domínio e não toca em nenhuma kit_*', async () => {
    const { fake, rest, runOnce } = setup();
    await runOnce();
    fake.tables.set('outbox_dock_actions', [{ id: 1, invoice_access_key: 'k', payload: {} }]);
    const before = kitCounts(fake);
    expect(fake.rows('invoices').length).toBeGreaterThan(0);
    expect(fake.rows('proposals').length).toBeGreaterThan(0);

    await resetDomain(rest);

    for (const [table] of DOMAIN_TABLES) expect(fake.rows(table)).toHaveLength(0);
    expect(kitCounts(fake)).toEqual(before);
    const deletes = fake.requests.filter((r) => r.method === 'DELETE');
    expect(deletes.every((r) => !new URL(r.url).pathname.includes('/kit_'))).toBe(true);
  });

  it('roda a captura e a conferência de novo: as 80 notas voltam com proposta', async () => {
    const { fake, rest, runOnce } = setup();
    await runOnce();
    await reconferir(rest, {}, undefined, runOnce);
    expect(fake.rows('invoices')).toHaveLength(80);
    expect(fake.rows('proposals')).toHaveLength(80);
    expect(fake.rows('invoices').every((r) => r.state === 'com_proposta' || r.state === 'decidida')).toBe(true);
  });

  it('recusa apagar uma tabela da base do kit, antes de apagar qualquer coisa', async () => {
    const { fake, rest, runOnce } = setup();
    await runOnce();
    await expect(resetDomain(rest, [['invoices', 'access_key'], ['kit_notas', 'chave']])).rejects.toThrow(/base do kit/);
    expect(fake.rows('invoices')).toHaveLength(80);
  });

  it('a lista de tabelas é só do domínio', () => {
    expect(DOMAIN_TABLES.every(([t]) => !t.startsWith('kit_'))).toBe(true);
    expect(DOMAIN_TABLES.map(([t]) => t)).toEqual([
      'invoices',
      'outbox_dock_actions',
      'outbox_store_actions',
      'outbox_registry_corrections',
      'outbox_return_notes',
      'approvals',
      'proposals',
      'divergences',
      'titles',
    ]);
  });
});

// #12 O pedido ao fornecedor sobrevive ao reconferir: as duas tabelas não são do domínio apagado e nenhuma FK as prende a ele.
describe('#12 reconferir e as tabelas do pedido ao fornecedor', () => { // ADR-002
  const sql = readFileSync(new URL('../../../supabase/migrations/20261117160000_supplier_request.sql', import.meta.url), 'utf8')
    .replace(/--[^\n]*/g, '');

  it('issued_return_notes e outbox_supplier_emails não estão em DOMAIN_TABLES', () => { // ADR-002
    const tables = DOMAIN_TABLES.map(([t]) => t);
    expect(tables).not.toContain('issued_return_notes');
    expect(tables).not.toContain('outbox_supplier_emails');
  });

  it('nenhuma tabela apagada pelo reconferir é alvo de FK das duas tabelas na migração', () => { // ADR-002
    const targets = [...sql.matchAll(/references public\.(\w+)/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    const deleted = DOMAIN_TABLES.map(([t]) => t);
    for (const target of targets) expect(deleted, target).not.toContain(target);
  });
});
