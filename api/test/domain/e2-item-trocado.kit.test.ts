import { beforeAll, describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import {
  amountAtRiskItemTrocado,
  approvalLevelItemTrocado,
  checkItemTrocado,
} from '../../src/domain/checks/e2-item-trocado.js';
import type { CheckContext, Invoice } from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

// #70: a E2 roda direto em cada nota da base do kit, offline. A lista abaixo vem da leitura dos dados
// do kit (ordem, nota e cadastro), e não de gabarito: a aplicação nunca lê um gabarito.
// Fim da chave de acesso → código do item trocado e o valor dele, em centavos.
const EXPECTED: Record<string, { code: string; cents: number }> = {
  '74512643': { code: 'F02-001', cents: 53568 }, // NF-001
  '53478484': { code: 'F04-003', cents: 635440 }, // NF-013
  '30119123': { code: 'F05-004', cents: 391216 }, // NF-040
  '92183529': { code: 'F07-001', cents: 273312 }, // NF-043
  '39161849': { code: 'F07-001', cents: 212576 }, // NF-045
  '18947616': { code: 'F05-002', cents: 74760 }, // NF-050
  '99597092': { code: 'F06-001', cents: 717120 }, // NF-051
  '81766520': { code: 'F11-001', cents: 52360 }, // NF-055
  '11816076': { code: 'F06-002', cents: 2882040 }, // NF-063
};

const tail = (i: Invoice) => i.accessKey.slice(-8);

let invoices: Invoice[];
let ctx: CheckContext;

beforeAll(async () => {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { sefaz, purchasing, registry, payables, bank, wms } = supabaseConnectors(rest).captureDeps;
  invoices = await sefaz.listIssuedInvoices();
  const [purchaseOrders, suppliers, products, postedInvoices, payments, receipts] = await Promise.all([
    purchasing.listPurchaseOrders(),
    registry.listSuppliers(),
    registry.listProducts(),
    payables.listPostedInvoices(),
    bank.listPayments(),
    wms.listReceipts(),
  ]);
  ctx = { purchaseOrders, suppliers, products, postedInvoices, payments, receipts, capturedInvoices: invoices };
});

describe('#36 E2 item trocado na base do kit (offline)', () => {
  it('#36/AC-1 regra 6: exatamente as 9 notas com item cadastrado no lugar do pedido são E2', () => {
    const flagged = invoices.filter((i) => checkItemTrocado(i, ctx).length > 0).map(tail);
    expect(flagged.sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const invoice of invoices.filter((i) => tail(i) in EXPECTED)) {
      const found = checkItemTrocado(invoice, ctx);
      expect(found).toHaveLength(1);
      expect(found[0]?.classification).toBe('E2');
      const swapped = invoice.items.find((it) => it.supplierCode === EXPECTED[tail(invoice)]?.code);
      expect(found[0]?.evidence[1]?.description.startsWith(`${swapped?.supplierCode} `)).toBe(true);
    }
  });

  it('#36/AC-2 regra 6: o valor em risco de cada E2 é o valor do item trocado', () => {
    for (const invoice of invoices) {
      const risk = amountAtRiskItemTrocado(invoice, ctx);
      expect(risk.amount.cents, invoice.accessKey).toBe(EXPECTED[tail(invoice)]?.cents ?? 0);
    }
  });

  it('#36/AC-3 regras 4 e 5: só a NF-063 (R$ 64.078,80) passa de R$ 20 mil e vai à coordenação', () => {
    const levels = Object.fromEntries(
      invoices.filter((i) => tail(i) in EXPECTED).map((i) => [tail(i), approvalLevelItemTrocado(i)]),
    );
    expect(levels['11816076']).toBe('coordenacao');
    const others = Object.entries(levels).filter(([k]) => k !== '11816076');
    expect(others).toHaveLength(8);
    expect(others.every(([, level]) => level === 'analista')).toBe(true);
  });
});
