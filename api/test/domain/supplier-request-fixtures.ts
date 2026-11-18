import {
  Invoice,
  Money,
  Quantity,
  buildReturnNote,
  type ReturnNoteDraft,
  type ReturnQueueEntry,
} from '../../src/domain/index.js';

// #156: a nota de origem e a devolução da fila que os testes do pedido ao fornecedor compartilham.
export const SOURCE_KEY = '35261174055489000148550010000438941174512643';

export const sourceInvoice = (): Invoice =>
  Invoice.receive({
    accessKey: SOURCE_KEY,
    number: '43894',
    series: '1',
    supplierId: 'F02',
    store: 'LJ-012',
    issuedOn: '2026-11-09',
    purchaseOrderRef: 'OC-2026-42328',
    entryChannel: 'sefaz',
    items: [
      {
        supplierCode: 'F02-002',
        sku: 'SKU-1006',
        description: 'Refrigerante cola 2 L',
        quantity: Quantity.of(72, 'UN'),
        unitPrice: Money.ofCents(849),
        total: Money.ofCents(61128),
      },
      {
        supplierCode: 'F02-004',
        sku: 'SKU-1008',
        description: 'Água de coco 1 L',
        quantity: Quantity.of(28, 'UN'),
        unitPrice: Money.ofCents(970),
        total: Money.ofCents(27160),
      },
      {
        supplierCode: 'F02-005',
        sku: null,
        description: 'Arroz 5 kg',
        quantity: Quantity.of(12, 'CX'),
        unitPrice: Money.ofCents(10000),
        total: Money.ofCents(120000),
      },
    ],
    total: Money.ofCents(208288),
  });

export const queueEntry = (overrides: Partial<ReturnQueueEntry> = {}): ReturnQueueEntry => ({
  invoiceAccessKey: SOURCE_KEY,
  lines: [
    { supplierCode: 'F02-002', amount: 7, unit: 'UN' },
    { supplierCode: 'F02-005', amount: 5, unit: 'CX' },
  ],
  ...overrides,
});

export const returnNote = (): ReturnNoteDraft => buildReturnNote(queueEntry(), sourceInvoice());
