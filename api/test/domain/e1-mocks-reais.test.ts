import { describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { checkFaltaFisica } from '../../src/domain/checks/e1-falta-fisica.js';
import { assessCount, countRoute, findReceipt, unreconciledReceipts, type CheckContext } from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

// #69 com os mocks do #80: a contagem vem de kit_recebimentos e kit_recebimento_itens pelo conector WMS.
async function fromMocks() {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { captureDeps: d } = supabaseConnectors(rest);
  const [invoices, receipts, purchaseOrders, products, suppliers] = await Promise.all([
    d.sefaz.listIssuedInvoices(),
    d.wms.listReceipts(),
    d.purchasing.listPurchaseOrders(),
    d.registry.listProducts(),
    d.registry.listSuppliers(),
  ]);
  const ctx: CheckContext = {
    receipts,
    purchaseOrders,
    products,
    suppliers,
    postedInvoices: [],
    payments: [],
    capturedInvoices: [],
  };
  return { invoices, receipts, ctx };
}

describe('#69 E1 sobre os mocks do WMS', () => {
  it('AC-1: das 80 notas, 58 se ligam a uma contagem pela chave de acesso', async () => {
    const { invoices, receipts } = await fromMocks();
    expect(invoices.filter((i) => findReceipt(i, receipts) !== null)).toHaveLength(58);
  });

  it('AC-1: 9 recebimentos sem chave e 4 com chave de nota fora da SEFAZ não conciliam e ficam registrados', async () => {
    const { invoices, receipts } = await fromMocks();
    const pending = unreconciledReceipts(receipts, invoices);
    expect(pending.filter((p) => p.reason === 'no_key').map((p) => p.receipt.id)).toEqual([
      'RC-9356', 'RC-9362', 'RC-9368', 'RC-9372', 'RC-9381', 'RC-9389', 'RC-9393', 'RC-9399', 'RC-9401',
    ]);
    expect(pending.filter((p) => p.reason === 'key_without_invoice')).toHaveLength(4);
  });

  it('AC-2: exatamente as 9 notas com item fora da contagem viram E1', async () => {
    const { invoices, ctx } = await fromMocks();
    const e1 = invoices.filter((i) => checkFaltaFisica(i, ctx).length > 0).map((i) => i.number).sort();
    expect(e1).toHaveLength(9);
    const receiptsOfE1 = invoices
      .filter((i) => checkFaltaFisica(i, ctx).length > 0)
      .map((i) => checkFaltaFisica(i, ctx)[0]?.evidence[0]?.reference)
      .sort();
    expect(receiptsOfE1).toEqual([
      'RC-9148', 'RC-9155', 'RC-9158', 'RC-9167', 'RC-9169', 'RC-9172', 'RC-9174', 'RC-9182', 'RC-9183',
    ]);
  });

  it('AC-6, linha 2: a nota 89408 (RC-9270, R$ 132.747,60) com a contagem que não bate vai à diretoria', async () => {
    const { invoices, ctx } = await fromMocks();
    const invoice = invoices.find((i) => i.number === '89408');
    if (!invoice) throw new Error('nota 89408 fora do kit');
    const assessment = assessCount(invoice, ctx);
    expect(assessment.status).toBe('mismatch');
    expect(countRoute(invoice, assessment, ctx.suppliers)).toBe('diretoria');
  });
});
