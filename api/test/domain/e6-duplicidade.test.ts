import { describe, expect, it, vi } from 'vitest';
import {
  blockDuplicateTitle,
  checkDuplicidade,
  duplicateReason,
} from '../../src/domain/checks/e6-duplicidade.js';
import {
  CHECKS,
  DomainError,
  InvalidTransitionError,
  Invoice,
  Money,
  Quantity,
  Title,
  type Check,
  type InvoiceItem,
  type InvoiceProps,
} from '../../src/domain/index.js';
import {
  aPostedInvoice,
  aPurchaseOrder,
  aPurchaseOrderItem,
  anInvoice,
  emptyContext,
} from './fixtures.js';
import { draftProposal, propose } from '../../src/domain/approval.js';
import { ApprovalPolicy } from '../../src/domain/approval-policy.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

// Valores copiados do kit (data/kit/notas.json, notas_lancadas.json). Nada é importado do JSON.

const item = (
  supplierCode: string,
  sku: string | null,
  description: string,
  quantity: number,
  unitPriceCents: number,
): InvoiceItem => ({
  supplierCode,
  sku,
  description,
  quantity: Quantity.of(quantity, 'UN'),
  unitPrice: Money.ofCents(unitPriceCents),
  total: Money.ofCents(quantity * unitPriceCents),
});

const kitInvoice = (props: Omit<InvoiceProps, 'series' | 'entryChannel'>): Invoice =>
  Invoice.receive({ ...props, series: '1', entryChannel: 'SEFAZ' });

/** NF-012 do kit: cobra de novo a ordem OC-2026-42812, já lançada pela nota 89410. */
const nf012 = (): Invoice =>
  kitInvoice({
    accessKey: '35261194433432000143550010000894281178831290',
    number: '89428',
    supplierId: 'F03',
    store: 'LJ-030',
    issuedOn: '2026-11-11',
    purchaseOrderRef: 'OC-2026-42812',
    items: [
      item('F03-002', 'SKU-1010', 'Tomate italiano kg', 44, 850),
      item('F03-001', 'SKU-1009', 'Banana prata kg', 60, 690),
      item('F03-003', 'SKU-1011', 'Alface crespa unidade', 124, 340),
    ],
    total: Money.ofCents(120960),
  });

const posted89410 = aPostedInvoice({
  accessKey: '35261194433432000143550010000894101464288543',
  number: '89410',
  supplierId: 'F03',
  purchaseOrderRef: 'OC-2026-42812',
  total: Money.ofCents(120960),
  status: 'lançada',
});

/** NF-058 do kit: cobra de novo a ordem OC-2026-42924, cujo título já foi pago. */
const nf058 = (): Invoice =>
  kitInvoice({
    accessKey: '35261113769729000182550010000137931847092345',
    number: '13793',
    supplierId: 'F07',
    store: 'CD-02',
    issuedOn: '2026-11-09',
    purchaseOrderRef: 'OC-2026-42924',
    items: [
      item('F07-001', 'SKU-1022', 'Pão de forma 500 g', 1012, 949),
      item('F07-002', 'SKU-1023', 'Bisnaguinha 300 g', 836, 799),
    ],
    total: Money.ofCents(1628352),
  });

const posted13773 = aPostedInvoice({
  accessKey: '35261113769729000182550010000137731145340609',
  number: '13773',
  supplierId: 'F07',
  purchaseOrderRef: 'OC-2026-42924',
  total: Money.ofCents(1628352),
  status: 'paga',
});

/** NF-020 do kit: o título lançado é o dela mesma, com a mesma chave. */
const nf020Props: Omit<InvoiceProps, 'series' | 'entryChannel'> = {
    accessKey: '35261147573594000106550010000131371591560338',
    number: '13137',
    supplierId: 'F06',
    store: 'CD-02',
    issuedOn: '2026-11-05',
    purchaseOrderRef: 'OC-2026-42950',
    items: [
      item('F06-002', 'SKU-1020', 'Pizza congelada 460 g', 1492, 2190),
      item('F06-003', 'SKU-1021', 'Sorvete 1,5 L', 1788, 2690),
      item('F06-001', 'SKU-1019', 'Pão de queijo congelado 1 kg', 1524, 2490),
    ],
    total: Money.ofCents(11871960),
  };
const nf020 = (): Invoice => kitInvoice(nf020Props);

const posted13137 = aPostedInvoice({
  accessKey: '35261147573594000106550010000131371591560338',
  number: '13137',
  supplierId: 'F06',
  purchaseOrderRef: 'OC-2026-42950',
  total: Money.ofCents(11871960),
  status: 'lançada',
});

const invoiceWith = (overrides: Partial<InvoiceProps>): Invoice =>
  Invoice.receive({
    accessKey: '35261100000000000000550010000012341000012345',
    number: '1234',
    series: '1',
    supplierId: 'F-001',
    store: 'L01',
    issuedOn: '2026-11-10',
    purchaseOrderRef: 'OC-100',
    entryChannel: 'sefaz',
    items: [item('A1', 'SKU-1', 'Arroz 5kg', 12, 10000)],
    total: Money.ofCents(120000),
    ...overrides,
  });

describe('E6 duplicidade: título já lançado', () => {
  it('#31/AC-2 regra 3: nota da mesma ordem e do mesmo valor de um título lançado é E6 (NF-012 do kit)', () => {
    const found = checkDuplicidade(nf012(), emptyContext({ postedInvoices: [posted89410] }));

    expect(found).toHaveLength(1);
    const [d] = found;
    expect(d?.classification).toBe('E6');
    expect(d?.skus).toEqual(['SKU-1010', 'SKU-1009', 'SKU-1011']);
    // Formato travado: web/src/evidence/e6.tsx tira número, ordem, valor e situação destas duas
    // descrições por regex. Mudar o texto aqui quebra a evidência E6 da tela.
    expect(d?.evidence).toEqual([
      {
        source: 'erp_contas_a_pagar',
        reference: '35261194433432000143550010000894101464288543',
        description: 'Título já lançado da nota 89410, ordem OC-2026-42812, R$ 1.209,60, situação lançada',
      },
      {
        source: 'sefaz',
        reference: '35261194433432000143550010000894281178831290',
        description: 'Nota 89428 cobra a mesma ordem e o mesmo valor',
      },
    ]);
    expect(duplicateReason(d!)).toBe('titulo_lancado');
  });

  it('#31/AC-2 regra 3: nota que cobra de novo um título já pago é E6 (NF-058 do kit)', () => {
    const found = checkDuplicidade(nf058(), emptyContext({ postedInvoices: [posted13773] }));

    expect(found).toHaveLength(1);
    expect(found[0]?.classification).toBe('E6');
    expect(found[0]?.evidence[0]?.reference).toBe('35261113769729000182550010000137731145340609');
    expect(found[0]?.evidence[0]?.description).toContain('situação paga');
  });

  it('#31/AC-2: mais de um título casando dá uma divergência só, com uma evidência por título', () => {
    const other = aPostedInvoice({ ...posted89410, accessKey: '35261194433432000143550010000894111000000001', number: '89411' });
    const found = checkDuplicidade(nf012(), emptyContext({ postedInvoices: [posted89410, other] }));

    expect(found).toHaveLength(1);
    const titles = found[0]!.evidence.filter((e) => e.source === 'erp_contas_a_pagar');
    expect(titles.map((e) => e.reference)).toEqual([posted89410.accessKey, other.accessKey]);
  });

  it('#142 regras 1 e 3: a mesma chave de um título já lançado é reenvio, E6 (NF-020 do kit)', () => {
    const found = checkDuplicidade(nf020(), emptyContext({ postedInvoices: [posted13137] }));

    expect(found).toHaveLength(1);
    expect(found[0]?.classification).toBe('E6');
    expect(duplicateReason(found[0]!)).toBe('titulo_lancado');
    // Formato travado (web/src/evidence/e6.tsx): título existente e canal de chegada.
    expect(found[0]?.evidence).toEqual([
      {
        source: 'erp_contas_a_pagar',
        reference: posted13137.accessKey,
        description: 'Título já lançado da nota 13137, ordem OC-2026-42950, R$ 118.719,60, situação lançada',
      },
      {
        source: 'sefaz',
        reference: posted13137.accessKey,
        description: 'Nota 13137 cobra de novo a mesma chave de acesso, reenvio pelo canal SEFAZ',
      },
    ]);
  });

  it('#142 regra 1: reenvio de título já pago, e sem ordem, também é E6', () => {
    const posted = aPostedInvoice({ ...posted13137, purchaseOrderRef: null, status: 'paga' });
    const found = checkDuplicidade(
      kitInvoice({ ...nf020Props, purchaseOrderRef: null }),
      emptyContext({ postedInvoices: [posted] }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence[0]?.description).toContain('situação paga');
  });

  it('#31/AC-2: mesma ordem e valor diferente não é E6', () => {
    const posted = aPostedInvoice({ ...posted89410, total: Money.ofCents(120961) });
    expect(checkDuplicidade(nf012(), emptyContext({ postedInvoices: [posted] }))).toEqual([]);
  });

  it('#31/AC-2: mesmo valor e outra ordem não é E6', () => {
    const posted = aPostedInvoice({ ...posted89410, purchaseOrderRef: 'OC-2026-99999' });
    expect(checkDuplicidade(nf012(), emptyContext({ postedInvoices: [posted] }))).toEqual([]);
  });

  it('#31/AC-2: nota sem ordem não é E6, nem contra título sem ordem', () => {
    const invoice = invoiceWith({ purchaseOrderRef: null });
    const posted = aPostedInvoice({ purchaseOrderRef: null, total: Money.ofCents(120000) });
    expect(checkDuplicidade(invoice, emptyContext({ postedInvoices: [posted] }))).toEqual([]);
  });
});

describe('E6 duplicidade suspeita: ordem sem saldo', () => {
  it('#31/AC-3 regra 5: item cobrado de ordem com saldo zero é E6 suspeita', () => {
    const order = aPurchaseOrder({ items: [aPurchaseOrderItem({ balance: Quantity.of(0, 'CX') })] });
    const found = checkDuplicidade(anInvoice(), emptyContext({ purchaseOrders: [order] }));

    expect(found).toHaveLength(1);
    const [d] = found;
    expect(d?.classification).toBe('E6');
    expect(d?.skus).toEqual(['SKU-1']);
    expect(d?.evidence).toHaveLength(1);
    expect(d?.evidence[0]?.source).toBe('erp_compras');
    expect(d?.evidence[0]?.reference).toBe('OC-100');
    expect(d?.evidence[0]?.description).toContain('Duplicidade suspeita: a ordem OC-100 não tem saldo para');
    expect(d?.evidence[0]?.description).toContain('Arroz 5kg');
    expect(duplicateReason(d!)).toBe('ordem_sem_saldo');
  });

  it('#31/AC-3 regra 5: saldo parcial maior que zero é entrega parcial, não divergência', () => {
    const order = aPurchaseOrder({ items: [aPurchaseOrderItem({ balance: Quantity.of(3, 'CX') })] });
    expect(checkDuplicidade(anInvoice(), emptyContext({ purchaseOrders: [order] }))).toEqual([]);
  });

  it('#31/AC-3 regra 5: o saldo compara só o número, mesmo em outra unidade', () => {
    const order = aPurchaseOrder({ items: [aPurchaseOrderItem({ balance: Quantity.of(0, 'UN') })] });
    expect(checkDuplicidade(anInvoice(), emptyContext({ purchaseOrders: [order] }))).toHaveLength(1);
  });

  it('#31/AC-3: ordem inexistente não é E6 (é E5, de outro plano)', () => {
    const order = aPurchaseOrder({ id: 'OC-OUTRA', items: [aPurchaseOrderItem({ balance: Quantity.of(0, 'CX') })] });
    expect(checkDuplicidade(anInvoice(), emptyContext({ purchaseOrders: [order] }))).toEqual([]);
  });

  it('#31/AC-3: nota sem ordem não procura saldo', () => {
    const order = aPurchaseOrder({ items: [aPurchaseOrderItem({ balance: Quantity.of(0, 'CX') })] });
    const invoice = invoiceWith({ purchaseOrderRef: null });
    expect(checkDuplicidade(invoice, emptyContext({ purchaseOrders: [order] }))).toEqual([]);
  });

  it('#31/AC-3: item da ordem sem SKU é casado pelo código do fornecedor', () => {
    const order = aPurchaseOrder({
      items: [aPurchaseOrderItem({ sku: null, supplierCode: 'A1', balance: Quantity.of(0, 'CX') })],
    });
    const found = checkDuplicidade(anInvoice(), emptyContext({ purchaseOrders: [order] }));
    expect(found).toHaveLength(1);
    expect(found[0]?.skus).toEqual(['SKU-1']);
  });

  it('#31/AC-3: sem casar pelo código, casa pelo SKU', () => {
    const order = aPurchaseOrder({
      items: [aPurchaseOrderItem({ sku: 'SKU-1', supplierCode: 'OUTRO', balance: Quantity.of(0, 'CX') })],
    });
    expect(checkDuplicidade(anInvoice(), emptyContext({ purchaseOrders: [order] }))).toHaveLength(1);
  });

  it('#142 regra 1: ordem sem saldo e título com a mesma chave: uma E6 só, de reenvio (NF-020 do kit)', () => {
    const order = aPurchaseOrder({
      id: 'OC-2026-42950',
      supplierId: 'F06',
      items: [
        aPurchaseOrderItem({ sku: 'SKU-1020', supplierCode: 'F06-002', balance: Quantity.of(0, 'UN') }),
        aPurchaseOrderItem({ sku: 'SKU-1021', supplierCode: 'F06-003', balance: Quantity.of(0, 'UN') }),
        aPurchaseOrderItem({ sku: 'SKU-1019', supplierCode: 'F06-001', balance: Quantity.of(0, 'UN') }),
      ],
    });
    const ctx = emptyContext({ postedInvoices: [posted13137], purchaseOrders: [order] });
    expect(checkDuplicidade(nf020(), ctx).map(duplicateReason)).toEqual(['titulo_lancado']);
  });

  it('#31/AC-3: título lançado e ordem sem saldo: uma E6 só, de motivo titulo_lancado', () => {
    const order = aPurchaseOrder({
      id: 'OC-2026-42812',
      items: [aPurchaseOrderItem({ sku: 'SKU-1010', supplierCode: 'F03-002', balance: Quantity.of(0, 'UN') })],
    });
    const found = checkDuplicidade(nf012(), emptyContext({ postedInvoices: [posted89410], purchaseOrders: [order] }));
    expect(found.map(duplicateReason)).toEqual(['titulo_lancado']);
  });
});

describe('E6 na base do kit inteira', () => {
  it('#31/AC-2 #31/AC-3 regras 1, 3 e 5: pelos conectores do kit, são E6 as 4 reemissões e os 5 reenvios (#142)', async () => {
    const fake = new FakePostgrest(kitTables());
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    const { captureDeps: d } = supabaseConnectors(rest);
    const [invoices, purchaseOrders, postedInvoices] = await Promise.all([
      d.sefaz.listIssuedInvoices(),
      d.purchasing.listPurchaseOrders(),
      d.payables.listPostedInvoices(),
    ]);
    const ctx = emptyContext({ purchaseOrders, postedInvoices, capturedInvoices: invoices });
    const idByKey = new Map(kitTables().kit_notas!.map((n) => [String(n.chave), String(n.nota_id)]));

    const e6 = invoices
      .map((i) => ({
        id: idByKey.get(i.accessKey),
        found: checkDuplicidade(i, { ...ctx, capturedInvoices: invoices.filter((o) => o.accessKey !== i.accessKey) }),
      }))
      .filter((r) => r.found.length > 0)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const reenvios = ['NF-020', 'NF-030', 'NF-041', 'NF-064', 'NF-075'];
    const reemissoes = ['NF-012', 'NF-058', 'NF-060', 'NF-074'];
    expect(e6.map((r) => r.id)).toEqual([...reemissoes, ...reenvios].sort());
    // Título lançado dispensa a checagem de saldo: uma divergência por nota, de motivo titulo_lancado.
    expect(e6.map((r) => r.found.map(duplicateReason))).toEqual(e6.map(() => ['titulo_lancado']));

    // #142 regra 3: cada reenvio vai a bloqueio, recusar, com o valor da nota em risco (centavos do kit).
    const cents: Record<string, number> = { 'NF-020': 11871960, 'NF-030': 294996, 'NF-041': 940340, 'NF-064': 96000, 'NF-075': 1678156 };
    for (const id of reenvios) {
      const inv = invoices.find((x) => idByKey.get(x.accessKey) === id)!;
      inv.check({ ...ctx, capturedInvoices: invoices.filter((o) => o.accessKey !== inv.accessKey) }, CHECKS);
      expect(inv.classification, id).toBe('E6');
      expect(inv.total.cents, id).toBe(cents[id]);
      const route = ApprovalPolicy.route(inv, { paymentBlocked: false });
      expect(route.level, id).toBe('bloqueio');
      const draft = draftProposal(inv, null);
      const { proposal } = propose(inv, Title.post({ invoiceAccessKey: inv.accessKey, amount: inv.total, dueOn: '2026-11-20' }), { route, ...draft, today: '2026-11-15' });
      expect(proposal.dockAction, id).toEqual({ kind: 'recusar' });
      expect(proposal.amountAtRisk.amount.equals(inv.total), id).toBe(true);
    }
  });
});

describe('E6 na conferência', () => {
  it('#31/AC-2 regra 2: com a lista real, a nota duplicada termina E6 só com divergências E6', () => {
    const invoice = nf012();
    invoice.check(emptyContext({ postedInvoices: [posted89410] }), CHECKS);

    expect(invoice.classification).toBe('E6');
    expect(invoice.divergences.length).toBeGreaterThan(0);
    expect(invoice.divergences.every((d) => d.classification === 'E6')).toBe(true);
  });

  it('#31/AC-2 regra 2: achando E6, a conferência para e não roda a verificação seguinte', () => {
    const spy = vi.fn<Check>(() => []);
    const invoice = nf012();
    invoice.check(emptyContext({ postedInvoices: [posted89410] }), [
      { id: 'E6', run: checkDuplicidade },
      { id: 'E7', run: spy },
    ]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('#31/AC-2 regra 6: toda divergência E6 cita ao menos uma evidência', () => {
    const order = aPurchaseOrder({
      id: 'OC-2026-42812',
      items: [aPurchaseOrderItem({ sku: null, supplierCode: 'F03-002', balance: Quantity.of(0, 'UN') })],
    });
    const found = [
      ...checkDuplicidade(nf012(), emptyContext({ postedInvoices: [posted89410] })),
      ...checkDuplicidade(nf012(), emptyContext({ purchaseOrders: [order] })),
    ];
    expect(found.map(duplicateReason)).toEqual(['titulo_lancado', 'ordem_sem_saldo']);
    for (const d of found) expect(d.evidence.length).toBeGreaterThan(0);
  });
});

describe('Desfecho da duplicidade', () => {
  const conferredDuplicate = (): Invoice => {
    const invoice = nf012();
    invoice.check(emptyContext({ postedInvoices: [posted89410] }));
    return invoice;
  };
  const titleFor = (accessKey: string, invoice: Invoice): Title =>
    Title.post({ invoiceAccessKey: accessKey, amount: invoice.total, dueOn: '2026-11-20' });

  it('#31/AC-4 regra 3: pelo caminho do #63, a NF-012 vai a bloqueio, recusar e valor em risco igual ao total', () => {
    const invoice = nf012();
    invoice.check(emptyContext({ postedInvoices: [posted89410] }), CHECKS);
    expect(invoice.classification).toBe('E6');

    const route = ApprovalPolicy.route(invoice, { paymentBlocked: false });
    expect(route.level).toBe('bloqueio');
    expect(route.line).toBe(1);

    const draft = draftProposal(invoice, null);
    const { proposal, approval } = propose(invoice, titleFor(invoice.accessKey, invoice), { route, ...draft, today: '2026-11-15' });
    expect(proposal.classification).toBe('E6');
    expect(proposal.dockAction).toEqual({ kind: 'recusar' });
    expect(proposal.level).toBe('bloqueio');
    expect(proposal.amountAtRisk.amount.equals(invoice.total)).toBe(true);
    expect(proposal.amountAtRisk.amount.equals(Money.ofCents(120960))).toBe(true);
    expect(proposal.state).toBe('aguardando_aprovacao');
    expect(approval).toBeNull();
  });

  it('#31/AC-5: o título da nota duplicada fica bloqueado e não entra na lista do dia', () => {
    const invoice = conferredDuplicate();
    const title = titleFor(invoice.accessKey, invoice);
    blockDuplicateTitle(invoice, title);

    expect(title.state).toBe('bloqueado');
    expect(() => title.scheduleToday()).toThrow(InvalidTransitionError);
  });

  it('#31/AC-5: basta a chave e a classificação E6 da nota, como vêm do banco', () => {
    const title = Title.post({ invoiceAccessKey: 'K-1', amount: Money.ofCents(100), dueOn: '2026-11-20' });
    blockDuplicateTitle({ accessKey: 'K-1', classification: 'E6' }, title);
    expect(title.state).toBe('bloqueado');
  });

  it('#31/AC-5 regra 3: título de outra chave (o original) não é bloqueado e continua lançado', () => {
    const invoice = conferredDuplicate();
    const original = titleFor(posted89410.accessKey, invoice);

    expect(() => blockDuplicateTitle(invoice, original)).toThrow(DomainError);
    expect(original.state).toBe('lancado');
  });

  it('#31/AC-5: nota que não é E6 não bloqueia o título', () => {
    const invoice = anInvoice();
    invoice.check(emptyContext());
    const title = titleFor(invoice.accessKey, invoice);
    expect(() => blockDuplicateTitle(invoice, title)).toThrow(DomainError);
    expect(title.state).toBe('lancado');
  });
});
