import { describe, expect, it } from 'vitest';
import {
  DockAction,
  Invoice,
  Money,
  Quantity,
  returnNoteFor,
  type Classification,
  type Product,
  type Receipt,
  type ReturnDecision,
  type Unit,
} from '../../src/domain/index.js';

const KEY = '35261100000000000000550010000099991000099999';

const item = (code: string, sku: string | null, amount: number, unit: Unit = 'UN') => ({
  supplierCode: code,
  sku,
  description: `Item ${code}`,
  quantity: Quantity.of(amount, unit),
  unitPrice: Money.ofCents(1000),
  total: Money.ofCents(1000 * amount),
});

const invoice = Invoice.receive({
  accessKey: KEY,
  number: '9999',
  series: '1',
  supplierId: 'F08',
  store: 'LJ-001',
  issuedOn: '2026-11-10',
  purchaseOrderRef: 'OC-1',
  entryChannel: 'SEFAZ',
  items: [item('F08-001', 'SKU-1', 100), item('F08-002', null, 10, 'CX'), item('F08-003', 'SKU-3', 5)],
  total: Money.ofCents(115_000),
});

const box: Product = {
  sku: 'SKU-2',
  description: 'Caixa',
  supplierId: 'F08',
  supplierCode: 'F08-002',
  baseUnit: 'UN',
  boxFactor: 6,
  referenceUnitPrice: Money.ofCents(1000),
};

const receipt = (
  items: readonly { supplierCode: string; amount: number; unit?: Unit }[],
  overrides: Partial<Receipt> = {},
): Receipt => ({
  id: 'RC-1',
  invoiceAccessKey: KEY,
  purchaseOrderId: 'OC-1',
  supplierId: 'F08',
  store: 'LJ-001',
  receivedOn: '2026-11-12',
  items: items.map((i) => ({
    supplierCode: i.supplierCode,
    description: `Item ${i.supplierCode}`,
    quantity: Quantity.of(i.amount, i.unit ?? 'UN'),
  })),
  note: '',
  ...overrides,
});

const decision = (
  classification: Classification,
  dockAction: DockAction,
  overrides: Partial<ReturnDecision> = {},
): ReturnDecision => ({ classification, state: 'aprovada', dockAction, decidedOn: '2026-11-12', ...overrides });

const lines = (note: ReturnType<typeof returnNoteFor>) =>
  note?.lines.map((l) => [l.supplierCode, l.quantity.amount, l.quantity.unit]);

describe('devolução da proposta decidida: returnNoteFor', () => {
  it('#156: E3 receber parcial devolve só as linhas devolver, na unidade do item da nota', () => {
    const action = DockAction.partial([
      { sku: 'SKU-1', quantity: Quantity.of(20, 'UN'), disposition: 'devolver' },
      { sku: 'F08-002', quantity: Quantity.of(2, 'CX'), disposition: 'devolver' },
      { sku: 'SKU-3', quantity: Quantity.of(1, 'UN'), disposition: 'segurar' },
    ]);
    const note = returnNoteFor(invoice, decision('E3', action), null, []);
    expect(lines(note)).toEqual([
      ['F08-001', 20, 'UN'],
      ['F08-002', 2, 'CX'],
    ]);
    expect(note?.invoiceAccessKey).toBe(KEY);
    expect(note?.reason).toBe('E3 quantidade menor na nota 9999: devolução da diferença');
  });

  it('#156: linha alterada em UN contra item de CX sai na unidade da nota (12 UN, fator 6, dá 2 CX)', () => {
    const action = DockAction.partial([{ sku: 'F08-002', quantity: Quantity.of(12, 'UN'), disposition: 'devolver' }]);
    const note = returnNoteFor(invoice, decision('E3', action, { state: 'alterada' }), null, [box]);
    expect(lines(note)).toEqual([['F08-002', 2, 'CX']]);
  });

  it('#156: linha em unidade diferente da nota sem fator de caixa é pulada, como na recusa', () => {
    const action = DockAction.partial([
      { sku: 'F08-002', quantity: Quantity.of(12, 'UN'), disposition: 'devolver' },
      { sku: 'SKU-1', quantity: Quantity.of(5, 'UN'), disposition: 'devolver' },
    ]);
    const note = returnNoteFor(invoice, decision('E3', action), null, []);
    expect(lines(note)).toEqual([['F08-001', 5, 'UN']]);
  });

  it('#156: a alterada também é decidida e vale a ação atual', () => {
    const action = DockAction.partial([{ sku: 'SKU-1', quantity: Quantity.of(5, 'UN'), disposition: 'devolver' }]);
    const note = returnNoteFor(invoice, decision('E3', action, { state: 'alterada' }), null, []);
    expect(lines(note)).toEqual([['F08-001', 5, 'UN']]);
  });

  it('#156: E1 receber parcial devolve simbolicamente as linhas seguradas', () => {
    const action = DockAction.partial([
      { sku: 'SKU-3', quantity: Quantity.of(5, 'UN'), disposition: 'segurar' },
      { sku: 'F08-002', quantity: Quantity.of(10, 'CX'), disposition: 'segurar' },
    ]);
    const note = returnNoteFor(invoice, decision('E1', action), null, []);
    expect(lines(note)).toEqual([
      ['F08-003', 5, 'UN'],
      ['F08-002', 10, 'CX'],
    ]);
    expect(note?.reason).toBe('E1 falta física na nota 9999: devolução simbólica dos itens ausentes da contagem');
  });

  it('#156: E2 receber parcial devolve só o item trocado', () => {
    const action = DockAction.partial([{ sku: 'SKU-3', quantity: Quantity.of(5, 'UN'), disposition: 'segurar' }]);
    const note = returnNoteFor(invoice, decision('E2', action), null, []);
    expect(lines(note)).toEqual([['F08-003', 5, 'UN']]);
    expect(note?.reason).toBe('E2 item trocado na nota 9999: devolução do item trocado');
  });

  it('#156: recusar com recebimento devolve os itens recebidos, na unidade da nota', () => {
    const r = receipt([
      { supplierCode: 'F08-001', amount: 100 },
      { supplierCode: 'F08-002', amount: 60 },
    ]);
    const note = returnNoteFor(invoice, decision('E2', DockAction.refuse()), r, [box]);
    expect(lines(note)).toEqual([
      ['F08-001', 100, 'UN'],
      ['F08-002', 10, 'CX'],
    ]);
    expect(note?.reason).toBe('E2 recusada na nota 9999: devolução dos itens já recebidos');
  });

  it('#156: recusar limita a devolução ao faturado', () => {
    const r = receipt([{ supplierCode: 'F08-001', amount: 130 }]);
    const note = returnNoteFor(invoice, decision('E3', DockAction.refuse()), r, []);
    expect(lines(note)).toEqual([['F08-001', 100, 'UN']]);
  });

  it('#156: recusar soma o recebido do mesmo código e converte caixa recebida em unidade da nota', () => {
    const r = receipt([
      { supplierCode: 'F08-001', amount: 30 },
      { supplierCode: 'F08-001', amount: 20 },
      { supplierCode: 'F08-002', amount: 4, unit: 'CX' },
    ]);
    const note = returnNoteFor(invoice, decision('E1', DockAction.refuse()), r, [box]);
    expect(lines(note)).toEqual([
      ['F08-001', 50, 'UN'],
      ['F08-002', 4, 'CX'],
    ]);
  });

  it('#156: recusar pula o item recebido que não dá para pôr na unidade da nota, e o de quantidade zero', () => {
    const r = receipt([
      { supplierCode: 'F08-001', amount: 0 },
      { supplierCode: 'F08-002', amount: 60 },
      { supplierCode: 'X-999', amount: 3 },
    ]);
    expect(returnNoteFor(invoice, decision('E2', DockAction.refuse()), r, [])).toBeNull();
  });

  it('#156: recusar mantém a quantidade proporcional exata na unidade da nota, mesmo fracionada (7 UN, fator 6, dá 7/6 CX)', () => {
    const r = receipt([{ supplierCode: 'F08-002', amount: 7, unit: 'UN' }]);
    const note = returnNoteFor(invoice, decision('E2', DockAction.refuse()), r, [box]);
    expect(lines(note)).toEqual([['F08-002', 7 / 6, 'CX']]);
  });

  it('#156: recusar soma o recebido por unidade antes de converter (seis linhas de 1 UN dão 1 CX, não 0,9999999999999999)', () => {
    const r = receipt(Array.from({ length: 6 }, () => ({ supplierCode: 'F08-002', amount: 1 })));
    const note = returnNoteFor(invoice, decision('E2', DockAction.refuse()), r, [box]);
    expect(lines(note)).toEqual([['F08-002', 1, 'CX']]);
  });

  it('#156: recusar uma NAO_CATALOGADA com recebimento até o dia da decisão devolve os itens recebidos', () => {
    const onDecisionDay = receipt([{ supplierCode: 'F08-001', amount: 40 }], { receivedOn: '2026-11-12' });
    const earlier = receipt([{ supplierCode: 'F08-001', amount: 40 }], { receivedOn: '2026-11-10' });
    const refuse = decision('NAO_CATALOGADA', DockAction.refuse());
    for (const r of [onDecisionDay, earlier]) {
      const note = returnNoteFor(invoice, refuse, r, []);
      expect(lines(note)).toEqual([['F08-001', 40, 'UN']]);
      expect(note?.reason).toBe('NAO_CATALOGADA recusada na nota 9999: devolução dos itens já recebidos');
    }
  });

  it('#156: recebimento do dia da decisão conta; do dia seguinte não', () => {
    const items = [{ supplierCode: 'F08-001', amount: 10 }];
    const sameDay = receipt(items, { receivedOn: '2026-11-12' });
    const earlier = receipt(items, { receivedOn: '2026-11-11' });
    const later = receipt(items, { receivedOn: '2026-11-13' });
    const refuse = decision('E3', DockAction.refuse());
    expect(returnNoteFor(invoice, refuse, sameDay, [])).not.toBeNull();
    expect(returnNoteFor(invoice, refuse, earlier, [])).not.toBeNull();
    expect(returnNoteFor(invoice, refuse, later, [])).toBeNull();
  });

  it('#156: recusar sem recebimento, ou com recebimento de outra nota, não devolve', () => {
    const refuse = decision('E3', DockAction.refuse());
    expect(returnNoteFor(invoice, refuse, null, [])).toBeNull();
    const other = receipt([{ supplierCode: 'F08-001', amount: 10 }], { invoiceAccessKey: '3526-outra' });
    expect(returnNoteFor(invoice, refuse, other, [])).toBeNull();
  });

  it('#156: receber e match não geram devolução', () => {
    const r = receipt([{ supplierCode: 'F08-001', amount: 100 }]);
    expect(returnNoteFor(invoice, decision('E3', DockAction.receive()), r, [])).toBeNull();
    expect(returnNoteFor(invoice, decision('MATCH', DockAction.receive()), r, [])).toBeNull();
  });

  it.each(['E4', 'E5', 'E6', 'E7', 'E8', 'MATCH'] as const)(
    '#156: %s não gera devolução, nem recusada com recebimento nem em receber parcial',
    (code) => {
      const r = receipt([{ supplierCode: 'F08-001', amount: 100 }]);
      const partial = DockAction.partial([{ sku: 'SKU-1', quantity: Quantity.of(5, 'UN'), disposition: 'devolver' }]);
      expect(returnNoteFor(invoice, decision(code, DockAction.refuse()), r, [])).toBeNull();
      expect(returnNoteFor(invoice, decision(code, partial), r, [])).toBeNull();
    },
  );

  it.each(['registrada', 'aguardando_aprovacao'] as const)(
    '#156: proposta %s não é decidida e não gera devolução',
    (state) => {
      const action = DockAction.partial([{ sku: 'SKU-1', quantity: Quantity.of(5, 'UN'), disposition: 'devolver' }]);
      const r = receipt([{ supplierCode: 'F08-001', amount: 100 }]);
      expect(returnNoteFor(invoice, decision('E3', action, { state }), null, [])).toBeNull();
      expect(returnNoteFor(invoice, decision('E3', DockAction.refuse(), { state }), r, [])).toBeNull();
    },
  );

  it('#156: E3 sem linha devolver não gera devolução', () => {
    const action = DockAction.partial([{ sku: 'SKU-3', quantity: Quantity.of(1, 'UN'), disposition: 'segurar' }]);
    expect(returnNoteFor(invoice, decision('E3', action), null, [])).toBeNull();
  });

  it('#156: a mesma decisão gera sempre a mesma devolução', () => {
    const r = receipt([
      { supplierCode: 'F08-002', amount: 60 },
      { supplierCode: 'F08-001', amount: 30 },
    ]);
    const d = decision('E2', DockAction.refuse());
    const first = returnNoteFor(invoice, d, r, [box]);
    expect(returnNoteFor(invoice, d, r, [box])).toEqual(first);
    expect(first?.lines.map((l) => l.supplierCode)).toEqual(['F08-001', 'F08-002']);
  });
});
