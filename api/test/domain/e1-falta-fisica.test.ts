import { describe, expect, it } from 'vitest';
import {
  amountAtRiskOfMissing,
  assessCount,
  findReceipt,
  Invoice,
  Money,
  Proposal,
  DockAction,
  Divergence,
  Quantity,
  reconcile,
  scheduleAfterCount,
  Title,
  unreconciledReceipts,
  type Product,
  type Receipt,
} from '../../src/domain/index.js';
import { routeDivergences } from '../../src/domain/approval-policy.js';
import { checkFaltaFisica } from '../../src/domain/checks/e1-falta-fisica.js';
import { anInvoice, emptyContext } from './fixtures.js';
import { kitInvoice, kitProducts, kitPurchaseOrders, kitReceipts } from './kit-contagem.js';

// #69 (história #44). Os casos vêm da base do kit: NF-078/RC-9107 bate; NF-053/RC-9148 e NF-025/RC-9182
// têm um item que não chegou (E1); NF-071/RC-9219 chegou a menos (E3, do #73); RC-9356 não tem nota.

const receipt = (id: string): Receipt => {
  const r = kitReceipts[id];
  if (!r) throw new Error(`recebimento fora da fixture: ${id}`);
  return r;
};

// #69: o encaminhamento tem uma fonte só, a régua da #63; a nota é conferida com todas as verificações.
const routed = (invoice: Invoice, supplier?: { paymentBlocked: boolean }) => {
  invoice.check(kitContext());
  return routeDivergences(invoice.divergences, invoice.total, supplier).level;
};

const kitContext = () =>
  emptyContext({
    receipts: Object.values(kitReceipts),
    purchaseOrders: kitPurchaseOrders,
    products: kitProducts,
  });

describe('AC-1: a contagem do WMS se liga à nota pela chave de acesso', () => {
  it('acha o recebimento da nota pela chave (NF-053 → RC-9148)', () => {
    expect(findReceipt(kitInvoice('NF-053'), Object.values(kitReceipts))?.id).toBe('RC-9148');
  });

  it('nota sem contagem ainda não acha recebimento', () => {
    expect(findReceipt(anInvoice(), Object.values(kitReceipts))).toBeNull();
  });

  it('o recebimento sem nota (RC-9356) não concilia, e fica registrado o motivo', () => {
    const invoices = ['NF-078', 'NF-053', 'NF-025', 'NF-071'].map(kitInvoice);
    const pending = unreconciledReceipts(Object.values(kitReceipts), invoices);
    expect(pending).toEqual([{ receipt: receipt('RC-9356'), reason: 'no_key' }]);
  });

  it('o recebimento com chave de uma nota que ainda não chegou fica registrado como key_without_invoice', () => {
    const pending = unreconciledReceipts([receipt('RC-9148')], []);
    expect(pending).toEqual([{ receipt: receipt('RC-9148'), reason: 'key_without_invoice' }]);
  });

  it('reconcile não cruza a nota com o recebimento de outra chave', () => {
    expect(reconcile(kitInvoice('NF-078'), receipt('RC-9148'), kitProducts)).toEqual([]);
  });
});

describe('AC-2: o item da nota que não aparece na contagem é E1', () => {
  it('NF-053: a batata chips (F11-001) não foi contada e vira E1, com evidência do WMS', () => {
    const [e1, ...rest] = checkFaltaFisica(kitInvoice('NF-053'), kitContext());
    expect(rest).toEqual([]);
    expect(e1?.classification).toBe('E1');
    expect(e1?.skus).toEqual(['SKU-1032']);
    expect(e1?.evidence.map((e) => [e.source, e.reference])).toEqual([
      ['wms', 'RC-9148'],
      ['erp_compras', 'OC-2026-42067'],
    ]);
  });

  it('regra 6: a divergência E1 cita ao menos uma evidência e a nota conferida fica E1', () => {
    const invoice = kitInvoice('NF-053');
    invoice.check(kitContext(), [{ id: 'E1', run: checkFaltaFisica }]);
    expect(invoice.classification).toBe('E1');
    expect(invoice.divergences[0]?.evidence.length).toBeGreaterThan(0);
  });

  it('NF-078: a contagem bate e não há E1', () => {
    expect(checkFaltaFisica(kitInvoice('NF-078'), kitContext())).toEqual([]);
  });

  it('NF-071: chegou a menos, mas chegou; é E3 (#73), não E1', () => {
    expect(checkFaltaFisica(kitInvoice('NF-071'), kitContext())).toEqual([]);
  });

  it('sem contagem ainda, não há E1: a nota espera a contagem (AC-5)', () => {
    expect(checkFaltaFisica(anInvoice(), emptyContext())).toEqual([]);
  });
});

describe('AC-3: a conciliação compara contagem, nota e pedido na mesma unidade', () => {
  const product: Product = {
    sku: 'SKU-1',
    description: 'Arroz 5kg',
    supplierId: 'F-001',
    supplierCode: 'A1',
    baseUnit: 'UN',
    boxFactor: 4,
    referenceUnitPrice: Money.ofCents(2500),
  };
  const countOf = (amount: number): Receipt => ({
    id: 'R1',
    invoiceAccessKey: anInvoice().accessKey,
    purchaseOrderId: 'OC-100',
    supplierId: 'F-001',
    store: 'L01',
    receivedOn: '2026-11-11',
    items: [{ supplierCode: 'A1', description: 'Arroz 5kg', quantity: Quantity.of(amount, 'UN') }],
    note: '',
  });

  it('regra 4: 12 CX na nota com fator 4 são 48 UN, e 48 UN contadas batem', () => {
    const [line] = reconcile(anInvoice(), countOf(48), [product]);
    expect(line?.invoiced).toEqual(Quantity.of(48, 'UN'));
    expect(line?.counted).toEqual(Quantity.of(48, 'UN'));
    expect(line?.missing).toEqual(Quantity.of(0, 'UN'));
  });

  it('regra 4: 40 UN contadas contra 12 CX deixam faltando 8 UN', () => {
    const [line] = reconcile(anInvoice(), countOf(40), [product]);
    expect(line?.missing).toEqual(Quantity.of(8, 'UN'));
  });

  it('AC-2: a nota que repete o código reparte a contagem; a segunda linha sem contagem é E1, a primeira não', () => {
    const base = anInvoice();
    const first = base.items[0];
    if (!first) throw new Error('fixture sem item');
    const twice = Invoice.receive({
      accessKey: base.accessKey,
      number: base.number,
      series: base.series,
      supplierId: base.supplierId,
      store: base.store,
      issuedOn: base.issuedOn,
      purchaseOrderRef: base.purchaseOrderRef,
      entryChannel: base.entryChannel,
      items: [first, { ...first, total: Money.ofCents(130000) }],
      total: Money.ofCents(250000),
    });
    const lines = reconcile(twice, countOf(48), [product]);
    expect(lines.map((l) => l.counted.amount)).toEqual([48, 0]);
    const risk = amountAtRiskOfMissing(twice, lines);
    expect(risk.amount.cents).toBe(130000);
  });

  it('AC-2: com contagem para as duas linhas do mesmo código, nenhuma falta', () => {
    const base = anInvoice();
    const first = base.items[0];
    if (!first) throw new Error('fixture sem item');
    const twice = Invoice.receive({
      accessKey: base.accessKey,
      number: base.number,
      series: base.series,
      supplierId: base.supplierId,
      store: base.store,
      issuedOn: base.issuedOn,
      purchaseOrderRef: base.purchaseOrderRef,
      entryChannel: base.entryChannel,
      items: [first, first],
      total: Money.ofCents(240000),
    });
    expect(reconcile(twice, countOf(96), [product]).map((l) => l.missing.amount)).toEqual([0, 0]);
  });

  it('item da nota sem contagem fica com contado zero e faltando tudo, já em UN', () => {
    const [line] = reconcile(anInvoice(), { ...countOf(0), items: [] }, [product]);
    expect(line?.counted).toEqual(Quantity.of(0, 'UN'));
    expect(line?.missing).toEqual(Quantity.of(48, 'UN'));
  });

  it('o pedido entra na comparação: contagem igual à nota, mas acima do saldo do pedido, não bate', () => {
    const ctx = emptyContext({
      products: [product],
      receipts: [countOf(48)],
      purchaseOrders: [
        {
          id: 'OC-100',
          supplierId: 'F-001',
          store: 'L01',
          issuedOn: '2026-11-01',
          status: 'aberta',
          statusReason: '',
          items: [
            {
              sku: 'SKU-1',
              supplierCode: 'A1',
              description: 'Arroz 5kg',
              quantity: Quantity.of(10, 'CX'),
              unitPrice: Money.ofCents(10000),
              balance: Quantity.of(10, 'CX'),
            },
          ],
          total: Money.ofCents(100000),
        },
      ],
    });
    expect(assessCount(anInvoice(), ctx).status).toBe('mismatch');
  });

  it('o mesmo pedido com saldo de 12 CX (48 UN) bate', () => {
    const ctx = emptyContext({
      products: [product],
      receipts: [countOf(48)],
      purchaseOrders: [
        {
          id: 'OC-100',
          supplierId: 'F-001',
          store: 'L01',
          issuedOn: '2026-11-01',
          status: 'aberta',
          statusReason: '',
          items: [
            {
              sku: 'SKU-1',
              supplierCode: 'A1',
              description: 'Arroz 5kg',
              quantity: Quantity.of(48, 'UN'),
              unitPrice: Money.ofCents(2500),
              balance: Quantity.of(48, 'UN'),
            },
          ],
          total: Money.ofCents(120000),
        },
      ],
    });
    expect(assessCount(anInvoice(), ctx).status).toBe('matches');
  });

  it('NF-078 (kit): contagem, nota e pedido iguais em UN', () => {
    const assessment = assessCount(kitInvoice('NF-078'), kitContext());
    expect(assessment.status).toBe('matches');
  });
});

describe('AC-4: o valor em risco do E1 é o valor dos itens que faltam', () => {
  it('NF-053: falta a batata chips, R$ 380,80', () => {
    const invoice = kitInvoice('NF-053');
    const lines = reconcile(invoice, receipt('RC-9148'), kitProducts);
    const risk = amountAtRiskOfMissing(invoice, lines);
    expect(risk.amount.cents).toBe(38080);
    expect(risk.invoiceTotal.cents).toBe(143200);
  });

  it('NF-025: falta a batata chips, R$ 28.655,20', () => {
    const invoice = kitInvoice('NF-025');
    const lines = reconcile(invoice, receipt('RC-9182'), kitProducts);
    expect(amountAtRiskOfMissing(invoice, lines).amount.cents).toBe(2865520);
  });

  it('o item que chegou a menos (E3) não entra no valor em risco do E1', () => {
    const invoice = kitInvoice('NF-071');
    const lines = reconcile(invoice, receipt('RC-9219'), kitProducts);
    expect(amountAtRiskOfMissing(invoice, lines).amount.isZero()).toBe(true);
  });

  it('a evidência do WMS diz quanto falta e o valor', () => {
    const [e1] = checkFaltaFisica(kitInvoice('NF-053'), kitContext());
    expect(e1?.evidence[0]?.description).toContain('R$ 380,80');
  });
});

describe('AC-5: o título só vai para a lista do dia depois da contagem conciliada', () => {
  const titleOf = (invoice: Invoice) =>
    Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: '2026-11-20' });

  it('sem contagem, o título liberado não entra na lista do dia', () => {
    const invoice = anInvoice();
    const title = titleOf(invoice);
    title.release();
    expect(() => scheduleAfterCount(title, assessCount(invoice, emptyContext()))).toThrow(/contagem/);
    expect(title.state).toBe('liberado');
  });

  it('com a contagem conciliada, o título liberado entra na lista do dia', () => {
    const invoice = kitInvoice('NF-078');
    const title = titleOf(invoice);
    title.release();
    scheduleAfterCount(title, assessCount(invoice, kitContext()));
    expect(title.state).toBe('na_lista_do_dia');
  });

  it('a conciliação de outra nota não serve para o título', () => {
    const title = titleOf(kitInvoice('NF-053'));
    title.release();
    expect(() => scheduleAfterCount(title, assessCount(kitInvoice('NF-078'), kitContext()))).toThrow();
  });
});

describe('AC-6: a contagem que não bate vai ao aprovador pelos limites', () => {
  it('NF-053 (R$ 1.432,00): E1 em nota de até R$ 20 mil vai ao analista (linha 5)', () => {
    const invoice = kitInvoice('NF-053');
    const level = routed(invoice);
    expect(level).toBe('analista');
    const proposal = Proposal.register({
      classification: 'E1',
      dockAction: DockAction.receive(),
      level,
      amountAtRisk: amountAtRiskOfMissing(invoice, reconcile(invoice, receipt('RC-9148'), kitProducts)),
      justification: 'falta a batata chips na contagem',
    });
    proposal.awaitApproval();
    expect(proposal.state).toBe('aguardando_aprovacao');
  });

  it('NF-025 (R$ 64.916,80): E1 em nota acima de R$ 20 mil vai à coordenação (linha 4)', () => {
    const invoice = kitInvoice('NF-025');
    expect(routed(invoice)).toBe('coordenacao');
  });

  it('linha 2: fornecedor com pagamento bloqueado leva a contagem que não bate à diretoria', () => {
    const invoice = kitInvoice('NF-053');
    expect(routed(invoice, { paymentBlocked: true })).toBe('diretoria');
  });

  it('linha 2 vem antes da 6: nem a contagem que bate segue pela regra com fornecedor bloqueado', () => {
    const invoice = kitInvoice('NF-078');
    expect(routed(invoice, { paymentBlocked: true })).toBe('diretoria');
  });

  it('linha 1: a nota com E6 vai a bloqueio, mesmo com a contagem batendo', () => {
    const invoice = kitInvoice('NF-078');
    invoice.check(kitContext(), [
      {
        id: 'E6',
        run: () => [
          Divergence.of({ classification: 'E6', skus: [], evidence: [{ source: 'sefaz', reference: 'x', description: 'teste' }] }),
        ],
      },
    ]);
    expect(routeDivergences(invoice.divergences, invoice.total).level).toBe('bloqueio');
  });
});

describe('AC-7: a contagem que bate segue pela regra, sem pessoa (gateway "A contagem bate?")', () => {
  it('NF-078: contagem, nota e pedido batem; o nível é regra e a proposta é aprovada sem pessoa', () => {
    const invoice = kitInvoice('NF-078');
    const level = routed(invoice);
    expect(level).toBe('regra');
    const proposal = Proposal.register({
      classification: 'MATCH',
      dockAction: DockAction.receive(),
      level,
      amountAtRisk: amountAtRiskOfMissing(invoice, reconcile(invoice, receipt('RC-9107'), kitProducts)),
      justification: 'a contagem bate com a nota e o pedido',
    });
    proposal.approveByRule();
    expect(proposal.state).toBe('aprovada');
  });

  it('NF-071: chegou a menos, então a contagem não bate e não segue pela regra', () => {
    const invoice = kitInvoice('NF-071');
    expect(assessCount(invoice, kitContext()).status).toBe('mismatch');
    expect(routed(invoice)).toBe('analista');
  });
});
