import { describe, expect, it } from 'vitest';
import {
  amountAtRiskOfShortfall,
  isShortLine,
  checkQuantidadeMenor,
  proposeE3,
  settleE3,
} from '../../src/domain/checks/e3-quantidade-menor.js';
import {
  DomainError,
  Invoice,
  Money,
  Proposal,
  Quantity,
  Title,
  type CheckContext,
  type PurchaseOrder,
  type Receipt,
  type ReconciliationLine,
  type Unit,
} from '../../src/domain/index.js';
import { emptyContext } from './fixtures.js';

const KEY = '35261100000000000000550010000099991000099999';

const invoice = (totalCents = 100_000, supplierId = 'F08'): Invoice =>
  Invoice.receive({
    accessKey: KEY,
    number: '9999',
    series: '1',
    supplierId,
    store: 'LJ-001',
    issuedOn: '2026-11-10',
    purchaseOrderRef: 'OC-1',
    entryChannel: 'SEFAZ',
    items: [
      {
        supplierCode: 'F08-001',
        sku: 'SKU-1',
        description: 'Óleo de soja 900 ml',
        quantity: Quantity.of(100, 'UN'),
        unitPrice: Money.ofCents(1000),
        total: Money.ofCents(totalCents),
      },
    ],
    total: Money.ofCents(totalCents),
  });

const receipt = (invoiceAccessKey: string | null = KEY): Receipt => ({
  id: 'RC-1',
  invoiceAccessKey,
  purchaseOrderId: 'OC-1',
  supplierId: 'F08',
  store: 'LJ-001',
  receivedOn: '2026-11-12',
  items: [],
  note: '',
});

const order = { id: 'OC-1' } as PurchaseOrder;

const line = (invoiced: number, counted: number, countedUnit: Unit = 'UN'): ReconciliationLine => ({
  supplierCode: 'F08-001',
  sku: 'SKU-1',
  invoiced: Quantity.of(invoiced, 'UN'),
  counted: Quantity.of(counted, countedUnit),
  missing: Quantity.of(invoiced - counted, 'UN'),
});

/** #73: contagem do WMS ligada à nota; contado zero é o item que não aparece na contagem. */
const counted = (amount: number, unit: Unit = 'UN', invoiceAccessKey: string | null = KEY): Receipt => ({
  ...receipt(invoiceAccessKey),
  items:
    amount === 0
      ? []
      : [{ supplierCode: 'F08-001', description: 'Óleo de soja 900 ml', quantity: Quantity.of(amount, unit) }],
});

const ctx = (overrides: Partial<CheckContext> = {}) =>
  emptyContext({ receipts: [receipt()], purchaseOrders: [order], ...overrides });

describe('#73 E3 quantidade menor: a verificação', () => {
  it('#73/AC-1, regras 4 e 6: contado menor que o faturado, na mesma unidade, marca E3 com evidência do WMS e da ordem', () => {
    const [d, ...rest] = checkQuantidadeMenor(invoice(), ctx({ receipts: [counted(75)] }));
    expect(rest).toEqual([]);
    expect(d?.classification).toBe('E3');
    expect(d?.skus).toEqual(['SKU-1']);
    expect(d?.evidence).toEqual([
      { source: 'wms', reference: 'RC-1', description: 'Contado 75 UN de 100 UN: Óleo de soja 900 ml' },
      { source: 'erp_compras', reference: 'OC-1', description: 'Ordem cobrada pela nota 9999' },
    ]);
  });

  it('#73/AC-1, regra 6: sem a ordem no contexto, a evidência é só a do WMS', () => {
    const [d] = checkQuantidadeMenor(invoice(), ctx({ receipts: [counted(75)], purchaseOrders: [] }));
    expect(d?.evidence.map((e) => e.source)).toEqual(['wms']);
  });

  it('#73/AC-1: contado zero não é E3 (é falta física, E1)', () => {
    expect(checkQuantidadeMenor(invoice(), ctx({ receipts: [counted(0)] }))).toEqual([]);
  });

  it('#73/AC-1: contado igual ao faturado não é E3', () => {
    expect(checkQuantidadeMenor(invoice(), ctx({ receipts: [counted(100)] }))).toEqual([]);
  });

  it('#73/AC-1: contado acima do faturado não é E3', () => {
    expect(checkQuantidadeMenor(invoice(), ctx({ receipts: [counted(120)] }))).toEqual([]);
  });

  it('#73/AC-1, regra 4: unidades diferentes não são E3', () => {
    expect(checkQuantidadeMenor(invoice(), ctx({ receipts: [counted(5, 'CX')] }))).toEqual([]);
    expect(isShortLine(line(100, 5, 'CX'))).toBe(false);
  });

  it('#73/AC-1: recebimento com chave nula nunca casa com a nota', () => {
    expect(checkQuantidadeMenor(invoice(), ctx({ receipts: [counted(75, 'UN', null)] }))).toEqual([]);
  });

  it('#73/AC-1: nota sem recebimento não é E3', () => {
    expect(checkQuantidadeMenor(invoice(), ctx({ receipts: [] }))).toEqual([]);
  });
});

describe('#73 E3 quantidade menor: proposta e liquidação', () => {
  it('#73/AC-2, regra 6: valor em risco é o valor do item proporcional ao que faltou', () => {
    expect(amountAtRiskOfShortfall(invoice(78_900), [line(100, 75)]).amount.cents).toBe(19_725);
  });

  it('#73/AC-2: a proposta é receber parcial, devolvendo a diferença, com valor em risco igual à diferença', () => {
    const props = proposeE3(invoice(78_900), ctx(), [line(100, 75)]);
    expect(props.classification).toBe('E3');
    expect(props.dockAction.kind).toBe('receber_parcial');
    const [l] = props.dockAction.kind === 'receber_parcial' ? props.dockAction.lines : [];
    expect(l?.sku).toBe('SKU-1');
    expect(l?.disposition).toBe('devolver');
    expect(l?.quantity.equals(Quantity.of(25, 'UN'))).toBe(true);
    expect(props.amountAtRisk.amount.cents).toBe(19_725);
    expect(props.justification).toContain('contado 75 UN de 100 UN');
  });

  it('#73/AC-2, limites de aprovação linhas 4 e 5: até R$ 20 mil é analista; acima, coordenação', () => {
    expect(proposeE3(invoice(2_000_000), ctx(), [line(100, 75)]).level).toBe('analista');
    expect(proposeE3(invoice(2_000_001), ctx(), [line(100, 75)]).level).toBe('coordenacao');
  });

  it('#73/AC-2, limites de aprovação linha 2: nota acima de R$ 100 mil ou fornecedor bloqueado vai à diretoria', () => {
    expect(proposeE3(invoice(10_000_000), ctx(), [line(100, 75)]).level).toBe('coordenacao');
    expect(proposeE3(invoice(10_000_001), ctx(), [line(100, 75)]).level).toBe('diretoria');
    const blocked = {
      id: 'F08',
      legalName: 'Fornecedor bloqueado',
      cnpj: '00.000.000/0001-00',
      paymentBlocked: true,
      blockReason: 'pendência fiscal',
    };
    expect(proposeE3(invoice(78_900), ctx({ suppliers: [blocked] }), [line(100, 75)]).level).toBe(
      'diretoria',
    );
  });

  it('#73/AC-2: sem linha a menos não há proposta de E3', () => {
    expect(() => proposeE3(invoice(), ctx(), [line(100, 0)])).toThrow(DomainError);
  });

  const approved = (inv: Invoice) => {
    const p = Proposal.register(proposeE3(inv, ctx(), [line(100, 75)]));
    p.awaitApproval();
    p.approve();
    return p;
  };

  it('#73/AC-3 e AC-4: a proposta aprovada reduz o título ao valor recebido e dá a nota de devolução da diferença', () => {
    const inv = invoice(78_900);
    const title = Title.post({ invoiceAccessKey: KEY, amount: inv.total, dueOn: '2026-12-10' });
    const note = settleE3(approved(inv), title, inv, [line(100, 75)]);
    expect(title.state).toBe('reduzido');
    expect(title.amount.cents).toBe(78_900 - 19_725);
    expect(note.invoiceAccessKey).toBe(KEY);
    expect(note.lines).toHaveLength(1);
    expect(note.lines[0]?.supplierCode).toBe('F08-001');
    expect(note.lines[0]?.quantity.equals(Quantity.of(25, 'UN'))).toBe(true);
  });

  it('#73/AC-3, regra 8: proposta não aprovada ou alterada não é liquidada', () => {
    const inv = invoice(78_900);
    const title = () => Title.post({ invoiceAccessKey: KEY, amount: inv.total, dueOn: '2026-12-10' });
    const waiting = Proposal.register(proposeE3(inv, ctx(), [line(100, 75)]));
    waiting.awaitApproval();
    expect(() => settleE3(waiting, title(), inv, [line(100, 75)])).toThrow(DomainError);
    const altered = Proposal.register(proposeE3(inv, ctx(), [line(100, 75)]));
    altered.awaitApproval();
    altered.alter({ kind: 'receber' }, 'aceita a carga como veio');
    const t = title();
    expect(() => settleE3(altered, t, inv, [line(100, 75)])).toThrow(DomainError);
    expect(t.state).toBe('lancado');
  });

  it('#73/AC-4, regra 8: a devolução que não bate com a ação na doca aprovada não é liquidada', () => {
    const inv = invoice(78_900);
    const title = Title.post({ invoiceAccessKey: KEY, amount: inv.total, dueOn: '2026-12-10' });
    expect(() => settleE3(approved(inv), title, inv, [line(100, 60)])).toThrow(DomainError);
    expect(title.state).toBe('lancado');
  });

  it('#73/AC-3: título já reduzido não é reduzido de novo', () => {
    const inv = invoice(78_900);
    const title = Title.post({ invoiceAccessKey: KEY, amount: inv.total, dueOn: '2026-12-10' });
    const proposal = approved(inv);
    settleE3(proposal, title, inv, [line(100, 75)]);
    expect(() => settleE3(proposal, title, inv, [line(100, 75)])).toThrow(DomainError);
    expect(title.amount.cents).toBe(78_900 - 19_725);
  });

  it('#73/AC-3: título de outra nota não é reduzido', () => {
    const inv = invoice(78_900);
    const other = Title.post({ invoiceAccessKey: 'OUTRA', amount: inv.total, dueOn: '2026-12-10' });
    expect(() => settleE3(approved(inv), other, inv, [line(100, 75)])).toThrow(DomainError);
    expect(other.state).toBe('lancado');
  });
});
