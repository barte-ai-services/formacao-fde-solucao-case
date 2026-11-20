// #337/AC-3: a ação na doca que o domínio decide por classificação (DOCK_ACTION_BY_CLASSIFICATION) tem de ser a que o motor determinístico
// #337 de fato propõe, em toda nota do kit (draftForChecked, o mesmo caminho de proposeChecked, que grava a proposta da regra): a constante não pode se afastar do motor.
// #337 O teste anterior rodava só draftChecked e só as notas de uma classificação: a E5 (nota sem ordem) sai por draftNotaSemOrdem, que ele nunca chamava, e a constante dizia receber onde o motor recusa.
import { describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { draftForChecked } from '../../src/domain/draft-checked.js';
import { DOCK_ACTION_BY_CLASSIFICATION, PRECEDENCE, type CheckContext, type Classification, type DockAction, type Invoice } from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

async function checkedKit(): Promise<{ invoice: Invoice; kind: DockAction['kind'] }[]> {
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: new FakePostgrest(kitTables()).fetch });
  const { captureDeps: d } = supabaseConnectors(rest);
  const [invoices, purchaseOrders, suppliers, products, postedInvoices, payments, receipts] = await Promise.all([
    d.sefaz.listIssuedInvoices(), d.purchasing.listPurchaseOrders(), d.registry.listSuppliers(), d.registry.listProducts(),
    d.payables.listPostedInvoices(), d.bank.listPayments(), d.wms.listReceipts(),
  ]);
  const ctx: CheckContext = { purchaseOrders, suppliers, products, postedInvoices, payments, receipts, capturedInvoices: [] };
  return invoices.map((invoice) => {
    invoice.check({ ...ctx, capturedInvoices: invoices.filter((i) => i !== invoice) });
    return { invoice, kind: draftForChecked(invoice, ctx).dockAction.kind };
  });
}

describe('#337/AC-3 a constante da ação na doca por classificação segue a regra do domínio', () => {
  it('#337/AC-3: tem uma entrada para MATCH, E1 a E8 e NAO_CATALOGADA, e só elas', () => {
    expect(Object.keys(DOCK_ACTION_BY_CLASSIFICATION).sort()).toEqual([...PRECEDENCE, 'MATCH'].sort());
  });

  it('#337/AC-3: a ação que o motor propõe para toda nota do kit, de qualquer classificação, está entre as que a constante diz para ela', async () => {
    const notes = await checkedKit();
    expect(notes.length).toBe(80);
    for (const { invoice, kind } of notes) {
      const rule = DOCK_ACTION_BY_CLASSIFICATION[invoice.classification];
      const allowed = [rule.usual, rule.wholeInvoiceHeld, rule.nothingToHold].filter((a) => a !== undefined);
      expect([invoice.number, invoice.classification, allowed.includes(kind)]).toEqual([invoice.number, invoice.classification, true]);
    }
  });

  it('#337/AC-3: a classificação sem alternativa na constante só tem a ação usual no kit, e a usual aparece onde há nota', async () => {
    const seen = new Map<Classification, Set<string>>();
    for (const { invoice, kind } of await checkedKit()) seen.set(invoice.classification, (seen.get(invoice.classification) ?? new Set()).add(kind));
    for (const [code, kinds] of seen) {
      const rule = DOCK_ACTION_BY_CLASSIFICATION[code];
      expect([code, kinds.has(rule.usual)]).toEqual([code, true]);
      if (rule.wholeInvoiceHeld === undefined && rule.nothingToHold === undefined) expect([code, [...kinds]]).toEqual([code, [rule.usual]]);
    }
    for (const code of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'MATCH'] as const) expect(seen.has(code), `kit sem nota ${code}`).toBe(true);
    expect(seen.get('E2')).toContain(DOCK_ACTION_BY_CLASSIFICATION.E2.wholeInvoiceHeld);
  });

  it('#337/AC-3: a nota sem ordem de compra do kit é recusada pelo motor (E5), e E4, E7 e E8 seguem o que a constante diz', async () => {
    const notes = await checkedKit();
    const noOrder = notes.filter(({ invoice }) => invoice.purchaseOrderRef === null && invoice.classification === 'E5');
    expect(noOrder.length).toBeGreaterThan(0);
    for (const { invoice, kind } of noOrder) expect([invoice.number, kind]).toEqual([invoice.number, 'recusar']);
    for (const code of ['E4', 'E7', 'E8'] as const) {
      for (const { invoice, kind } of notes.filter((n) => n.invoice.classification === code)) expect([invoice.number, code, kind]).toEqual([invoice.number, code, DOCK_ACTION_BY_CLASSIFICATION[code].usual]);
    }
  });

  it('#337/AC-3: o que o domínio decide, classificação a classificação', () => {
    const usual = Object.fromEntries(Object.entries(DOCK_ACTION_BY_CLASSIFICATION).map(([code, rule]) => [code, rule.usual]));
    expect(usual).toEqual({
      MATCH: 'receber', E1: 'receber_parcial', E2: 'receber_parcial', E3: 'receber_parcial', E4: 'receber',
      E5: 'recusar', E6: 'recusar', E7: 'receber', E8: 'receber_parcial', NAO_CATALOGADA: 'receber',
    });
  });
});
