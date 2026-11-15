import { Invoice, Money, Quantity, type CheckContext } from '../../src/domain/index.js';

export const emptyContext = (overrides: Partial<CheckContext> = {}): CheckContext => ({
  purchaseOrders: [],
  suppliers: [],
  products: [],
  postedInvoices: [],
  payments: [],
  receipts: [],
  capturedInvoices: [],
  ...overrides,
});

export const anInvoice = (accessKey = '35261100000000000000550010000012341000012345'): Invoice =>
  Invoice.receive({
    accessKey,
    number: '1234',
    series: '1',
    supplierId: 'F-001',
    store: 'L01',
    issuedOn: '2026-11-10',
    purchaseOrderRef: 'OC-100',
    entryChannel: 'sefaz',
    items: [
      {
        supplierCode: 'A1',
        sku: 'SKU-1',
        description: 'Arroz 5kg',
        quantity: Quantity.of(12, 'CX'),
        unitPrice: Money.ofCents(10000),
        total: Money.ofCents(120000),
      },
    ],
    total: Money.ofCents(120000),
  });
