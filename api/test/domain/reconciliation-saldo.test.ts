import { describe, expect, it } from 'vitest';
import {
  assessCount,
  Invoice,
  Money,
  Quantity,
  type Product,
  type Receipt,
  type Unit,
} from '../../src/domain/index.js';
import { aPurchaseOrder, aPurchaseOrderItem, emptyContext } from './fixtures.js';

// #116 (bug de #44, AC-3 e AC-7). Regra 5: a nota só cobra o saldo publicado por Compras para o item
// da ordem. Linhas repetidas do mesmo item consomem o mesmo saldo; não se compara cada uma com o saldo inteiro.

const KEY = '35261100000000000000550010000012341000012345';

const product = (boxFactor = 4): Product => ({
  sku: 'SKU-1',
  description: 'Arroz 5kg',
  supplierId: 'F-001',
  supplierCode: 'A1',
  baseUnit: 'UN',
  boxFactor,
  referenceUnitPrice: Money.ofCents(2500),
});

type Line = { code: string; sku: string | null; amount: number; unit?: Unit };

const invoiceOf = (lines: readonly Line[]): Invoice =>
  Invoice.receive({
    accessKey: KEY,
    number: '1234',
    series: '1',
    supplierId: 'F-001',
    store: 'L01',
    issuedOn: '2026-11-10',
    purchaseOrderRef: 'OC-100',
    entryChannel: 'sefaz',
    items: lines.map((l) => ({
      supplierCode: l.code,
      sku: l.sku,
      description: 'Arroz 5kg',
      quantity: Quantity.of(l.amount, l.unit ?? 'UN'),
      unitPrice: Money.ofCents(100),
      total: Money.ofCents(100 * l.amount),
    })),
    total: Money.ofCents(100 * lines.reduce((s, l) => s + l.amount, 0)),
  });

// A contagem sempre cobre o faturado (em UN), para isolar o saldo do pedido.
const receiptOf = (code: string, units: number): Receipt => ({
  id: 'RC-1',
  invoiceAccessKey: KEY,
  purchaseOrderId: 'OC-100',
  supplierId: 'F-001',
  store: 'L01',
  receivedOn: '2026-11-10',
  items: [{ supplierCode: code, description: 'Arroz 5kg', quantity: Quantity.of(units, 'UN') }],
  note: '',
});

const ctxOf = (units: number, balance: Quantity, orderCode = 'A1', orderSku: string | null = 'SKU-1') =>
  emptyContext({
    products: [product()],
    receipts: [receiptOf('A1', units)],
    purchaseOrders: [
      aPurchaseOrder({
        items: [aPurchaseOrderItem({ supplierCode: orderCode, sku: orderSku, balance })],
      }),
    ],
  });

describe('#116 regra 5: linhas repetidas consomem o saldo do item do pedido', () => {
  it('critério 2: duas linhas de 6 UN contra saldo de 10 UN dão mismatch', () => {
    const inv = invoiceOf([
      { code: 'A1', sku: 'SKU-1', amount: 6 },
      { code: 'A1', sku: 'SKU-1', amount: 6 },
    ]);
    expect(assessCount(inv, ctxOf(12, Quantity.of(10, 'UN'))).status).toBe('mismatch');
  });

  it('critério 3: linhas de 6 e 4 UN contra saldo de 10 UN dão matches', () => {
    const inv = invoiceOf([
      { code: 'A1', sku: 'SKU-1', amount: 6 },
      { code: 'A1', sku: 'SKU-1', amount: 4 },
    ]);
    expect(assessCount(inv, ctxOf(10, Quantity.of(10, 'UN'))).status).toBe('matches');
  });

  it('critério 4 (código do fornecedor): linhas sem SKU casam o item pelo código e somam', () => {
    const lines = [
      { code: 'A1', sku: null, amount: 6 },
      { code: 'A1', sku: null, amount: 6 },
    ];
    const ctx = ctxOf(12, Quantity.of(10, 'UN'), 'A1', null);
    expect(assessCount(invoiceOf(lines), ctx).status).toBe('mismatch');
    expect(assessCount(invoiceOf(lines), ctxOf(12, Quantity.of(12, 'UN'), 'A1', null)).status).toBe('matches');
  });

  it('critério 4 (fallback por SKU): código diferente no pedido, mesmo SKU, soma contra o mesmo saldo', () => {
    const lines = [
      { code: 'A1', sku: 'SKU-1', amount: 6 },
      { code: 'A1', sku: 'SKU-1', amount: 6 },
    ];
    expect(assessCount(invoiceOf(lines), ctxOf(12, Quantity.of(10, 'UN'), 'ZZ', 'SKU-1')).status).toBe('mismatch');
    expect(assessCount(invoiceOf(lines), ctxOf(12, Quantity.of(12, 'UN'), 'ZZ', 'SKU-1')).status).toBe('matches');
  });

  it('critério 4 (CX → UN): 2 CX + 8 UN (fator 4 = 16 UN) contra saldo de 3 CX (12 UN) dá mismatch', () => {
    const lines = [
      { code: 'A1', sku: 'SKU-1', amount: 2, unit: 'CX' as const },
      { code: 'A1', sku: 'SKU-1', amount: 8 },
    ];
    expect(assessCount(invoiceOf(lines), ctxOf(16, Quantity.of(3, 'CX'))).status).toBe('mismatch');
  });

  it('critério 4 (CX → UN): 2 CX + 4 UN (12 UN) contra saldo de 3 CX (12 UN) dá matches', () => {
    const lines = [
      { code: 'A1', sku: 'SKU-1', amount: 2, unit: 'CX' as const },
      { code: 'A1', sku: 'SKU-1', amount: 4 },
    ];
    expect(assessCount(invoiceOf(lines), ctxOf(12, Quantity.of(3, 'CX'))).status).toBe('matches');
  });

  it('critério 5: linha única continua comparada com o saldo (cabe ou não cabe)', () => {
    const one = invoiceOf([{ code: 'A1', sku: 'SKU-1', amount: 10 }]);
    expect(assessCount(one, ctxOf(10, Quantity.of(10, 'UN'))).status).toBe('matches');
    expect(assessCount(one, ctxOf(10, Quantity.of(9, 'UN'))).status).toBe('mismatch');
  });
});
