import type { Published, ReturnNoteMessage, ReturnNoteOutbox } from '../../src/connectors/ports.js';
import { DockAction, Invoice, Money, Quantity, type Classification, type Product, type Receipt, type Unit } from '../../src/domain/index.js';
import type { DecidedReturnCase } from '../../src/returns/publish-return-note.js';

// #7 Apoio dos testes de api/test/returns: nota decidida e caixa de saída em memória.
export const KEY = '35261100000000000000550010000099991000099999';
export const OTHER_KEY = '35261100000000000000550010000088881000088888';

const item = (code: string, sku: string, amount: number, unit: Unit = 'UN') => ({
  supplierCode: code,
  sku,
  description: `Item ${code}`,
  quantity: Quantity.of(amount, unit),
  unitPrice: Money.ofCents(1000),
  total: Money.ofCents(1000 * amount),
});

const invoiceOf = (accessKey: string, number: string) =>
  Invoice.receive({
    accessKey,
    number,
    series: '1',
    supplierId: 'F08',
    store: 'LJ-001',
    issuedOn: '2026-11-10',
    purchaseOrderRef: 'OC-1',
    entryChannel: 'SEFAZ',
    items: [item('F08-001', 'SKU-1', 100), item('F08-003', 'SKU-3', 50)],
    total: Money.ofCents(150_000),
  });

export const receipt = (id: string, receivedOn: string, items: readonly [string, number][], accessKey: string | null = KEY): Receipt => ({
  id,
  invoiceAccessKey: accessKey,
  purchaseOrderId: 'OC-1',
  supplierId: 'F08',
  store: 'LJ-001',
  receivedOn,
  items: items.map(([supplierCode, amount]) => ({ supplierCode, description: supplierCode, quantity: Quantity.of(amount, 'UN') })),
  note: '',
});

const NO_PRODUCTS: readonly Product[] = [];

export function decided(
  classification: Classification,
  dockAction: DockAction,
  over: Partial<DecidedReturnCase> = {},
  accessKey = KEY,
): DecidedReturnCase {
  return {
    invoice: invoiceOf(accessKey, accessKey === KEY ? '9999' : '8888'),
    decision: { classification, state: 'aprovada', dockAction, decidedOn: '2026-11-12' },
    receipts: [],
    products: NO_PRODUCTS,
    ...over,
  };
}

export const partialE3 = (): DockAction =>
  DockAction.partial([{ sku: 'SKU-1', quantity: Quantity.of(20, 'UN'), disposition: 'devolver' }]);

export type MemoryOutbox = {
  readonly outbox: ReturnNoteOutbox;
  readonly rows: Published<ReturnNoteMessage>[];
  readonly calls: { publish: number; list: number };
};

/** #7 Dublê em memória da caixa de saída: grava toda publicação e conta as chamadas; a idempotência testada é a da varredura. */
export function memoryOutbox(seed: readonly ReturnNoteMessage[] = []): MemoryOutbox {
  const rows: Published<ReturnNoteMessage>[] = seed.map((m, i) => ({ ...m, id: i + 1, publishedAt: '2026-11-12T10:00:00Z' }));
  const calls = { publish: 0, list: 0 };
  const outbox: ReturnNoteOutbox = {
    publish: (message) => {
      calls.publish += 1;
      const row = { ...message, id: rows.length + 1, publishedAt: '2026-11-12T11:00:00Z' };
      rows.push(row);
      return Promise.resolve(row);
    },
    list: () => {
      calls.list += 1;
      return Promise.resolve([...rows]);
    },
  };
  return { outbox, rows, calls };
}
