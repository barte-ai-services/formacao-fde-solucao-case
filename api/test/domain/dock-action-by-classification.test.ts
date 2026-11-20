// #337/AC-3: a ação na doca que o domínio decide por classificação (DOCK_ACTION_BY_CLASSIFICATION) tem de ser a que a regra determinística
// #337 de fato propõe (draftProposal e draftChecked), nas notas do kit: a constante não pode se afastar da regra.
import { describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { priceDifference } from '../../src/domain/checks/nao-catalogada.js';
import { draftChecked } from '../../src/domain/draft-checked.js';
import { DOCK_ACTION_BY_CLASSIFICATION, PRECEDENCE, type CheckContext, type Classification, type Invoice } from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

async function checkedKit(): Promise<{ invoice: Invoice; kind: string }[]> {
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: new FakePostgrest(kitTables()).fetch });
  const { captureDeps: d } = supabaseConnectors(rest);
  const [invoices, purchaseOrders, suppliers, products, postedInvoices, payments, receipts] = await Promise.all([
    d.sefaz.listIssuedInvoices(), d.purchasing.listPurchaseOrders(), d.registry.listSuppliers(), d.registry.listProducts(),
    d.payables.listPostedInvoices(), d.bank.listPayments(), d.wms.listReceipts(),
  ]);
  const ctx: CheckContext = { purchaseOrders, suppliers, products, postedInvoices, payments, receipts, capturedInvoices: [] };
  return invoices.map((invoice) => {
    invoice.check({ ...ctx, capturedInvoices: invoices.filter((i) => i !== invoice) });
    return { invoice, kind: draftChecked(invoice, ctx, priceDifference(invoice, ctx)?.overcharge ?? null).dockAction.kind };
  });
}

describe('#337/AC-3 a constante da ação na doca por classificação segue a regra do domínio', () => {
  it('#337/AC-3: tem uma entrada para MATCH, E1 a E8 e NAO_CATALOGADA, e só elas', () => {
    expect(Object.keys(DOCK_ACTION_BY_CLASSIFICATION).sort()).toEqual([...PRECEDENCE, 'MATCH'].sort());
  });

  it('#337/AC-3: a ação de cada nota do kit com uma só classificação está entre as que a constante diz para ela', async () => {
    const notes = (await checkedKit()).filter(({ invoice }) => new Set(invoice.divergences.map((d) => d.classification)).size <= 1);
    const seen = new Map<Classification, Set<string>>();
    for (const { invoice, kind } of notes) {
      const rule = DOCK_ACTION_BY_CLASSIFICATION[invoice.classification];
      const allowed = [rule.usual, rule.wholeInvoiceHeld, rule.nothingToHold].filter((a) => a !== undefined);
      expect([invoice.number, invoice.classification, allowed.includes(kind as never)]).toEqual([invoice.number, invoice.classification, true]);
      seen.set(invoice.classification, (seen.get(invoice.classification) ?? new Set()).add(kind));
    }
    // #337/AC-3: a classificação sem alternativa na constante só tem a ação usual; e a usual aparece no kit onde há nota.
    for (const [code, kinds] of seen) {
      const rule = DOCK_ACTION_BY_CLASSIFICATION[code];
      if (rule.wholeInvoiceHeld === undefined && rule.nothingToHold === undefined) expect([code, [...kinds]]).toEqual([code, [rule.usual]]);
    }
    for (const code of ['E1', 'E2', 'E3', 'E4', 'E6', 'E8', 'MATCH'] as const) expect(seen.has(code), `kit sem nota ${code}`).toBe(true);
    expect(seen.get('E2')).toContain(DOCK_ACTION_BY_CLASSIFICATION.E2.wholeInvoiceHeld);
  });

  it('#337/AC-3: o que o domínio decide, classificação a classificação', () => {
    const usual = Object.fromEntries(Object.entries(DOCK_ACTION_BY_CLASSIFICATION).map(([code, rule]) => [code, rule.usual]));
    expect(usual).toEqual({
      MATCH: 'receber', E1: 'receber_parcial', E2: 'receber_parcial', E3: 'receber_parcial', E4: 'receber',
      E5: 'receber', E6: 'recusar', E7: 'receber', E8: 'receber_parcial', NAO_CATALOGADA: 'receber',
    });
  });
});
