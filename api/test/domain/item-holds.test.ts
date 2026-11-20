// #338: o que o motor segura nas notas E8 (item sem cadastro) e E2 (item trocado), e a ação na doca que decorre disso, como função pura do domínio:
// #338 o auditor entrega esses fatos ao modelo antes do laço; eles têm de ser os mesmos que o motor usa em draftForChecked (partE8, partE2, mergeLines, actionOf).
import { describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { CHECKS } from '../../src/domain/checks/index.js';
import { draftForChecked, itemHolds } from '../../src/domain/draft-checked.js';
import { Divergence, Invoice, type CheckContext } from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitDomain, kitInvoice, withItems } from '../support/kit-domain.js';
import { kitTables } from '../support/kit.js';

async function checkedKit(): Promise<{ invoices: readonly Invoice[]; ctx: CheckContext }> {
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: new FakePostgrest(kitTables()).fetch });
  const { captureDeps: d } = supabaseConnectors(rest);
  const [invoices, purchaseOrders, suppliers, products, postedInvoices, payments, receipts] = await Promise.all([
    d.sefaz.listIssuedInvoices(), d.purchasing.listPurchaseOrders(), d.registry.listSuppliers(), d.registry.listProducts(),
    d.payables.listPostedInvoices(), d.bank.listPayments(), d.wms.listReceipts(),
  ]);
  const ctx: CheckContext = { purchaseOrders, suppliers, products, postedInvoices, payments, receipts, capturedInvoices: [] };
  for (const invoice of invoices) invoice.check({ ...ctx, capturedInvoices: invoices.filter((i) => i !== invoice) });
  return { invoices, ctx };
}

const keyOf = (i: { sku: string | null; supplierCode: string }): string => i.sku ?? i.supplierCode;

describe('#338 itemHolds: os itens que a regra segura na E8 e na E2, e a ação na doca que decorre deles', () => {
  it('#338: nas notas E8 do kit, os itens sem cadastro são os que o motor segura, e a ação é a que o motor propõe', async () => {
    const { invoices, ctx } = await checkedKit();
    const e8 = invoices.filter((i) => i.classification === 'E8');
    expect(e8.length).toBeGreaterThan(0);
    for (const invoice of e8) {
      const holds = itemHolds(invoice, ctx);
      const draft = draftForChecked(invoice, ctx).dockAction;
      expect(holds?.unregistered.length).toBeGreaterThan(0);
      expect(holds?.swapped).toEqual([]);
      expect(holds?.dockAction?.kind).toBe(draft.kind);
      if (draft.kind === 'receber_parcial') expect(holds?.lines.map((l) => [l.sku, l.quantity.amount])).toEqual(draft.lines.map((l) => [l.sku, l.quantity.amount]));
      expect(holds?.lines.map((l) => l.sku)).toEqual(holds?.unregistered.map(keyOf));
    }
  });

  it('#338: nas notas E2 do kit, os itens trocados são os que o motor segura, e recusar quando é a nota inteira', async () => {
    const { invoices, ctx } = await checkedKit();
    const e2 = invoices.filter((i) => i.classification === 'E2');
    expect(e2.length).toBeGreaterThan(0);
    for (const invoice of e2) {
      const holds = itemHolds(invoice, ctx);
      const draft = draftForChecked(invoice, ctx).dockAction;
      expect(holds?.swapped.length).toBeGreaterThan(0);
      expect(holds?.unregistered).toEqual([]);
      expect(holds?.dockAction?.kind).toBe(draft.kind);
      expect(holds?.dockAction?.kind === 'recusar').toBe(holds?.swapped.length === invoice.items.length);
    }
    expect(e2.some((i) => i.items.length === 1)).toBe(true);
  });

  it('#338: a nota sem E8 nem E2 (match, E1, E3..E7) não tem itens segurados por estas regras: null', async () => {
    const { invoices, ctx } = await checkedKit();
    for (const invoice of invoices.filter((i) => !i.divergences.some((d) => d.classification === 'E8' || d.classification === 'E2'))) {
      expect([invoice.number, itemHolds(invoice, ctx)]).toEqual([invoice.number, null]);
    }
  });

  it('#338: nota E5 com E8 (o motor recusa só pela E5) não devolve a ação do E8: null, como a E6 e a E7', async () => {
    const kit = await kitDomain();
    const nf = kitInvoice(kit, 'NF-009');
    const semOrdem = Invoice.receive({
      accessKey: nf.accessKey, number: nf.number, series: nf.series, supplierId: nf.supplierId, store: nf.store,
      issuedOn: nf.issuedOn, purchaseOrderRef: null, entryChannel: nf.entryChannel, items: nf.items, total: nf.total,
    });
    semOrdem.check(kit.ctx);
    expect(semOrdem.divergences.map((d) => d.classification)).toEqual(expect.arrayContaining(['E5', 'E8']));
    expect(itemHolds(semOrdem, kit.ctx)).toBeNull();
  });

  it('#338: com E1 ou E3 junto, a ação depende da contagem: os itens saem e a ação é null', async () => {
    const { invoices, ctx } = await checkedKit();
    const base = invoices.find((i) => i.classification === 'E8');
    if (base === undefined) throw new Error('kit sem E8');
    const extra = { id: 'E1' as const, run: () => [Divergence.of({ classification: 'E1', skus: [], evidence: [{ source: 'wms', reference: 'x', description: 'x' }] })] };
    const copy = withItems(base, base.items);
    copy.check(ctx, [...CHECKS.filter((c) => c.id === 'E8'), extra]);
    const holds = itemHolds(copy, ctx);
    expect(holds?.unregistered.length).toBeGreaterThan(0);
    expect(holds?.dockAction).toBeNull();
  });
});
