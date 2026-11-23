import { describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { routeDivergences } from '../../src/domain/approval-policy.js';
import type { CheckContext, Invoice } from '../../src/domain/index.js';
import { generateDemoBatch, nextSequenceStart, type DemoBatch, type DemoRows } from '../../src/demo/generator.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

const NOW = new Date('2026-11-23T12:00:00Z');
const SEEDS = [1, 2, 3, 7, 11, 42, 99, 123, 2026, 4827];

type Outcome = { readonly key: string; readonly expected: DemoBatch['expected'] extends ReadonlyMap<string, infer V> ? V : never; readonly classification: string; readonly level: string };

/** Base do kit mais as linhas geradas, lidas pelos conectores reais e conferidas pela regra da própria solução. (#349) */
async function reconcile(batches: readonly DemoBatch[]): Promise<Outcome[]> {
  const tables = kitTables();
  const merged: Record<string, Record<string, unknown>[]> = Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, [...r]]));
  for (const { rows } of batches) {
    for (const [table, list] of Object.entries(rows as DemoRows)) merged[table]?.push(...(list as Record<string, unknown>[]));
  }
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: new FakePostgrest(merged).fetch });
  const { sefaz, purchasing, registry, payables, bank, wms } = supabaseConnectors(rest).captureDeps;
  const invoices = await sefaz.listIssuedInvoices();
  const [purchaseOrders, suppliers, products, postedInvoices, payments, receipts] = await Promise.all([
    purchasing.listPurchaseOrders(),
    registry.listSuppliers(),
    registry.listProducts(),
    payables.listPostedInvoices(),
    bank.listPayments(),
    wms.listReceipts(),
  ]);
  const ctx: CheckContext = { purchaseOrders, suppliers, products, postedInvoices, payments, receipts, capturedInvoices: invoices };
  const expected = new Map(batches.flatMap((b) => [...b.expected]));
  const byKey = new Map<string, Invoice>(invoices.map((i) => [i.accessKey, i]));
  return [...expected].map(([key, e]) => {
    const invoice = byKey.get(key);
    if (!invoice) throw new Error(`nota gerada não lida pelo conector: ${key}`);
    invoice.check(ctx);
    const supplier = suppliers.find((s) => s.id === invoice.supplierId);
    const divergences = invoice.divergences.map((d) => ({ classification: d.classification }));
    return { key, expected: e, classification: invoice.classification, level: routeDivergences(divergences, invoice.total, supplier).level };
  });
}

function batchesFor(seeds: readonly number[], count: number): DemoBatch[] {
  let sequenceStart = 1;
  return seeds.map((seed) => {
    const batch = generateDemoBatch({ seed, count, now: NOW, sequenceStart });
    sequenceStart = nextSequenceStart(sequenceStart, count);
    return batch;
  });
}

describe('#349 a conferência da solução classifica as notas geradas como o gerador espera', () => {
  it('#349/AC-3 em todas as notas de várias sementes, a classificação e o nível esperados batem com os da regra', async () => {
    const outcomes = await reconcile(batchesFor(SEEDS, 8));
    expect(outcomes).toHaveLength(SEEDS.length * 8);
    const wrong = outcomes.filter((o) => o.classification !== o.expected.classification || o.level !== o.expected.level);
    expect(wrong.map((o) => ({ key: o.key.slice(-8), expected: o.expected, got: [o.classification, o.level] }))).toEqual([]);
  });

  it('#349/AC-3 a regra acha o mesmo em lotes pequenos, de 3 notas, lidos junto com a base', async () => {
    const outcomes = await reconcile(batchesFor([5, 6, 8, 13, 21], 3));
    expect(outcomes.filter((o) => o.classification !== o.expected.classification || o.level !== o.expected.level)).toEqual([]);
  });

  it('#349/AC-2 pela regra, em 100 notas aparecem todas as exceções, o match e todos os níveis', async () => {
    const outcomes = await reconcile(batchesFor([201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213], 8).slice(0, 13));
    const hundred = outcomes.slice(0, 100);
    expect(hundred).toHaveLength(100);
    const classes = new Set(hundred.map((o) => o.classification));
    for (const c of ['MATCH', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']) expect(classes.has(c)).toBe(true);
    const levels = new Set(hundred.map((o) => o.level));
    for (const l of ['regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio']) expect(levels.has(l)).toBe(true);
  });
});
