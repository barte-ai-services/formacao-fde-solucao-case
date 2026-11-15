import { routeDivergences } from '../../src/domain/approval-policy.js';
import { describe, expect, it } from 'vitest';
import type { RegistryCorrectionMessage, RegistryCorrectionOutbox } from '../../src/connectors/ports.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import {
  checkUnidadeDeMedida,
  type E4CorrectionOutbox,
  e4AmountAtRisk,
  e4ApprovalLevel,
  e4RegistryCorrections,
  publishE4Corrections,
  type E4RegistryCorrection,
} from '../../src/domain/checks/e4-unidade-de-medida.js';
import {
  AmountAtRisk,
  DockAction,
  Invoice,
  Money,
  Proposal,
  Quantity,
  type Classification,
  type Product,
  type PurchaseOrder,
  type Unit,
} from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { emptyContext } from './fixtures.js';

// Plano #67, história #37. Os casos do kit são montados à mão a partir de data/kit/{notas,ordens,
// produtos}.json, citando o id da nota. O gabarito (excecoes.json) não é lido (#37).

type Line = {
  supplierCode: string;
  sku: string | null;
  description: string;
  quantity: number;
  unit: Unit;
  unitPrice: number; // #67: reais, como o kit entrega; a conversão para centavos é da borda
};

type InvoiceCase = {
  accessKey: string;
  supplierId: string;
  purchaseOrderRef: string | null;
  items: readonly (Line & { total: number })[];
  total: number;
};

const invoiceOf = (c: InvoiceCase): Invoice =>
  Invoice.receive({
    accessKey: c.accessKey,
    number: c.accessKey.slice(25, 34),
    series: '1',
    supplierId: c.supplierId,
    store: 'CD-01',
    issuedOn: '2026-11-10',
    purchaseOrderRef: c.purchaseOrderRef,
    entryChannel: 'SEFAZ',
    items: c.items.map((i) => ({
      supplierCode: i.supplierCode,
      sku: i.sku,
      description: i.description,
      quantity: Quantity.of(i.quantity, i.unit),
      unitPrice: Money.fromReais(i.unitPrice),
      total: Money.fromReais(i.total),
    })),
    total: Money.fromReais(c.total),
  });

const orderOf = (id: string, supplierId: string, lines: readonly Line[], total: number): PurchaseOrder => ({
  id,
  supplierId,
  store: 'CD-01',
  issuedOn: '2026-11-05',
  status: 'aberta',
  statusReason: '',
  items: lines.map((l) => ({
    sku: l.sku,
    supplierCode: l.supplierCode,
    description: l.description,
    quantity: Quantity.of(l.quantity, l.unit),
    unitPrice: Money.fromReais(l.unitPrice),
    balance: Quantity.of(l.quantity, l.unit),
  })),
  total: Money.fromReais(total),
});

const productOf = (
  sku: string,
  supplierId: string,
  supplierCode: string,
  boxFactor: number,
  referenceUnitPrice: number,
): Product => ({
  sku,
  description: sku,
  supplierId,
  supplierCode,
  baseUnit: 'UN',
  boxFactor,
  referenceUnitPrice: Money.fromReais(referenceUnitPrice),
});

// #67, NF-008: SKU-1025 vem em CX (232 @ 18,76) contra a ordem em UN (928 @ 4,69), fator 4.
const nf008 = {
  invoice: invoiceOf({
    accessKey: '35261162833783000154550010000374521840226160',
    supplierId: 'F08',
    purchaseOrderRef: 'OC-2026-42673',
    items: [
      { supplierCode: 'F08-002', sku: 'SKU-1025', description: 'Macarrão espaguete 500 g', quantity: 232, unit: 'CX', unitPrice: 18.76, total: 4352.32 },
      { supplierCode: 'F08-001', sku: 'SKU-1024', description: 'Óleo de soja 900 ml', quantity: 312, unit: 'UN', unitPrice: 7.89, total: 2461.68 },
      { supplierCode: 'F08-003', sku: 'SKU-1026', description: 'Molho de tomate 340 g', quantity: 664, unit: 'UN', unitPrice: 3.99, total: 2649.36 },
    ],
    total: 9463.36,
  }),
  ctx: emptyContext({
    purchaseOrders: [
      orderOf(
        'OC-2026-42673',
        'F08',
        [
          { supplierCode: 'F08-002', sku: 'SKU-1025', description: 'Macarrão espaguete 500 g', quantity: 928, unit: 'UN', unitPrice: 4.69 },
          { supplierCode: 'F08-001', sku: 'SKU-1024', description: 'Óleo de soja 900 ml', quantity: 312, unit: 'UN', unitPrice: 7.89 },
          { supplierCode: 'F08-003', sku: 'SKU-1026', description: 'Molho de tomate 340 g', quantity: 664, unit: 'UN', unitPrice: 3.99 },
        ],
        9463.36,
      ),
    ],
    products: [
      productOf('SKU-1025', 'F08', 'F08-002', 4, 4.69),
      productOf('SKU-1024', 'F08', 'F08-001', 4, 7.89),
      productOf('SKU-1026', 'F08', 'F08-003', 4, 3.99),
    ],
  }),
};

// #67, NF-044: SKU-1022 vem em CX (867 @ 37,96) contra a ordem em UN (3468 @ 9,49), fator 4. Nota de R$ 53.685,32.
const nf044 = {
  invoice: invoiceOf({
    accessKey: '35261113769729000182550010000137591816304136',
    supplierId: 'F07',
    purchaseOrderRef: 'OC-2026-42742',
    items: [
      { supplierCode: 'F07-001', sku: 'SKU-1022', description: 'Pão de forma 500 g', quantity: 867, unit: 'CX', unitPrice: 37.96, total: 32911.32 },
      { supplierCode: 'F07-002', sku: 'SKU-1023', description: 'Bisnaguinha 300 g', quantity: 2600, unit: 'UN', unitPrice: 7.99, total: 20774.0 },
    ],
    total: 53685.32,
  }),
  ctx: emptyContext({
    purchaseOrders: [
      orderOf(
        'OC-2026-42742',
        'F07',
        [
          { supplierCode: 'F07-001', sku: 'SKU-1022', description: 'Pão de forma 500 g', quantity: 3468, unit: 'UN', unitPrice: 9.49 },
          { supplierCode: 'F07-002', sku: 'SKU-1023', description: 'Bisnaguinha 300 g', quantity: 2600, unit: 'UN', unitPrice: 7.99 },
        ],
        53685.32,
      ),
    ],
    products: [productOf('SKU-1022', 'F07', 'F07-001', 4, 9.49), productOf('SKU-1023', 'F07', 'F07-002', 4, 7.99)],
  }),
};

// #67, NF-067: SKU-1031 vem em CX (923 @ 25,96) contra a ordem em UN (3692 @ 6,49), fator 4. Nota de R$ 64.034,00.
const nf067 = {
  invoice: invoiceOf({
    accessKey: '35261153194517000138550010000844441912118632',
    supplierId: 'F10',
    purchaseOrderRef: 'OC-2026-42773',
    items: [
      { supplierCode: 'F10-002', sku: 'SKU-1030', description: 'Sabão em pó 1,6 kg', quantity: 768, unit: 'UN', unitPrice: 24.9, total: 19123.2 },
      { supplierCode: 'F10-003', sku: 'SKU-1031', description: 'Água sanitária 2 L', quantity: 923, unit: 'CX', unitPrice: 25.96, total: 23961.08 },
      { supplierCode: 'F10-001', sku: 'SKU-1029', description: 'Detergente 500 ml', quantity: 7788, unit: 'UN', unitPrice: 2.69, total: 20949.72 },
    ],
    total: 64034.0,
  }),
  ctx: emptyContext({
    purchaseOrders: [
      orderOf(
        'OC-2026-42773',
        'F10',
        [
          { supplierCode: 'F10-002', sku: 'SKU-1030', description: 'Sabão em pó 1,6 kg', quantity: 768, unit: 'UN', unitPrice: 24.9 },
          { supplierCode: 'F10-003', sku: 'SKU-1031', description: 'Água sanitária 2 L', quantity: 3692, unit: 'UN', unitPrice: 6.49 },
          { supplierCode: 'F10-001', sku: 'SKU-1029', description: 'Detergente 500 ml', quantity: 7788, unit: 'UN', unitPrice: 2.69 },
        ],
        64034.0,
      ),
    ],
    products: [
      productOf('SKU-1030', 'F10', 'F10-002', 4, 24.9),
      productOf('SKU-1031', 'F10', 'F10-003', 4, 6.49),
      productOf('SKU-1029', 'F10', 'F10-001', 4, 2.69),
    ],
  }),
};

// #67, NF-065: SKU-1018 vem em CX (38 @ 19,96) contra a ordem em UN (152 @ 4,99), fator 4.
const nf065 = {
  invoice: invoiceOf({
    accessKey: '35261154813096000149550010000706431621743193',
    supplierId: 'F05',
    purchaseOrderRef: 'OC-2026-42615',
    items: [
      { supplierCode: 'F05-002', sku: 'SKU-1016', description: 'Feijão carioca 1 kg', quantity: 60, unit: 'UN', unitPrice: 8.9, total: 534.0 },
      { supplierCode: 'F05-004', sku: 'SKU-1018', description: 'Açúcar refinado 1 kg', quantity: 38, unit: 'CX', unitPrice: 19.96, total: 758.48 },
      { supplierCode: 'F05-001', sku: 'SKU-1015', description: 'Arroz tipo 1 5 kg', quantity: 24, unit: 'UN', unitPrice: 27.9, total: 669.6 },
    ],
    total: 1962.08,
  }),
  ctx: emptyContext({
    purchaseOrders: [
      orderOf(
        'OC-2026-42615',
        'F05',
        [
          { supplierCode: 'F05-002', sku: 'SKU-1016', description: 'Feijão carioca 1 kg', quantity: 60, unit: 'UN', unitPrice: 8.9 },
          { supplierCode: 'F05-004', sku: 'SKU-1018', description: 'Açúcar refinado 1 kg', quantity: 152, unit: 'UN', unitPrice: 4.99 },
          { supplierCode: 'F05-001', sku: 'SKU-1015', description: 'Arroz tipo 1 5 kg', quantity: 24, unit: 'UN', unitPrice: 27.9 },
        ],
        1962.08,
      ),
    ],
    products: [
      productOf('SKU-1016', 'F05', 'F05-002', 4, 8.9),
      productOf('SKU-1018', 'F05', 'F05-004', 4, 4.99),
      productOf('SKU-1015', 'F05', 'F05-001', 4, 27.9),
    ],
  }),
};

// #67, NF-073: SKU-1014 vem em CX (8 @ 67,60) contra a ordem em UN (32 @ 16,90), fator 4.
// #67: os outros dois itens têm fator 12 no cadastro e vêm em UN dos dois lados, não são E4.
const nf073 = {
  invoice: invoiceOf({
    accessKey: '35261100023027000111550010000479761598126270',
    supplierId: 'F04',
    purchaseOrderRef: 'OC-2026-42644',
    items: [
      { supplierCode: 'F04-002', sku: 'SKU-1013', description: 'Creme dental 90 g', quantity: 144, unit: 'UN', unitPrice: 5.9, total: 849.6 },
      { supplierCode: 'F04-003', sku: 'SKU-1014', description: 'Shampoo 350 ml', quantity: 8, unit: 'CX', unitPrice: 67.6, total: 540.8 },
      { supplierCode: 'F04-001', sku: 'SKU-1012', description: 'Sabonete em barra 85 g', quantity: 308, unit: 'UN', unitPrice: 2.49, total: 766.92 },
    ],
    total: 2157.32,
  }),
  ctx: emptyContext({
    purchaseOrders: [
      orderOf(
        'OC-2026-42644',
        'F04',
        [
          { supplierCode: 'F04-002', sku: 'SKU-1013', description: 'Creme dental 90 g', quantity: 144, unit: 'UN', unitPrice: 5.9 },
          { supplierCode: 'F04-003', sku: 'SKU-1014', description: 'Shampoo 350 ml', quantity: 32, unit: 'UN', unitPrice: 16.9 },
          { supplierCode: 'F04-001', sku: 'SKU-1012', description: 'Sabonete em barra 85 g', quantity: 308, unit: 'UN', unitPrice: 2.49 },
        ],
        2157.32,
      ),
    ],
    products: [
      productOf('SKU-1013', 'F04', 'F04-002', 12, 5.9),
      productOf('SKU-1014', 'F04', 'F04-003', 4, 16.9),
      productOf('SKU-1012', 'F04', 'F04-001', 12, 2.49),
    ],
  }),
};

// #67, sintético: 12 CX, fator 4, contra a ordem de 48 UN. `boxPrice` em reais por caixa.
const synthetic = (boxPrice: number, orderUnit: Unit = 'UN', orderQty = 48, orderPrice = 10) => {
  const invoiceUnit: Unit = orderUnit === 'UN' ? 'CX' : 'UN';
  const invoiceQty = invoiceUnit === 'CX' ? 12 : 48;
  const total = invoiceQty * boxPrice;
  return {
    invoice: invoiceOf({
      accessKey: '35261100000000000000550010000099991000099999',
      supplierId: 'F01',
      purchaseOrderRef: 'OC-SINT',
      items: [{ supplierCode: 'F01-001', sku: 'SKU-1', description: 'Arroz 5 kg', quantity: invoiceQty, unit: invoiceUnit, unitPrice: boxPrice, total }],
      total,
    }),
    ctx: emptyContext({
      purchaseOrders: [
        orderOf(
          'OC-SINT',
          'F01',
          [{ supplierCode: 'F01-001', sku: 'SKU-1', description: 'Arroz 5 kg', quantity: orderQty, unit: orderUnit, unitPrice: orderPrice }],
          orderQty * orderPrice,
        ),
      ],
      products: [productOf('SKU-1', 'F01', 'F01-001', 4, 10)],
    }),
  };
};

const proposalFor = (invoice: Invoice, classification: Classification, until: 'registrada' | 'aguardando_aprovacao' | 'aprovada' | 'alterada'): Proposal => {
  const p = Proposal.register({
    classification,
    dockAction: DockAction.receive(),
    level: 'analista',
    amountAtRisk: AmountAtRisk.of(Money.zero(), invoice.total),
    justification: 'Caixa convertida bate com a ordem.',
  });
  if (until === 'registrada') return p;
  p.awaitApproval();
  if (until === 'aprovada') p.approve();
  if (until === 'alterada') p.alter(DockAction.receive(), 'Recebe tudo; o fator vai para o Cadastro.');
  return p;
};

const memoryOutbox = () => {
  const sent: E4RegistryCorrection[] = [];
  return {
    sent,
    publish: (m: E4RegistryCorrection): Promise<void> => {
      sent.push(m);
      return Promise.resolve();
    },
  };
};

describe('E4 — unidade de medida (plano #67, história #37)', () => {
  describe('AC-1: caixa que, convertida, bate com a ordem é E4', () => {
    it('regra 4, AC-1: 12 CX com fator 4 contra a ordem de 48 UN é E4, não diferença de preço', () => {
      const { invoice, ctx } = synthetic(40);
      const found = checkUnidadeDeMedida(invoice, ctx);
      expect(found).toHaveLength(1);
      expect(found[0]?.classification).toBe('E4');
      expect(found[0]?.skus).toEqual(['SKU-1']);
    });

    it('regra 4, AC-1, #67: 10 CX com fator 4 (40 UN) contra a ordem de 48 UN é E4, e o risco é sobre 40 UN', () => {
      const invoice = invoiceOf({
        accessKey: '35261100000000000000550010000066661000066666',
        supplierId: 'F01',
        purchaseOrderRef: 'OC-SINT',
        items: [{ supplierCode: 'F01-001', sku: 'SKU-1', description: 'Arroz 5 kg', quantity: 10, unit: 'CX', unitPrice: 40, total: 400 }],
        total: 400,
      });
      const { ctx } = synthetic(40);
      const found = checkUnidadeDeMedida(invoice, ctx);
      expect(found).toHaveLength(1);
      expect(found[0]?.classification).toBe('E4');
      expect(found[0]?.skus).toEqual(['SKU-1']);
      expect(found[0]?.evidence[2]?.description).toContain('nota 40 UN, ordem 48 UN');
      expect(e4AmountAtRisk(invoice, ctx).amount.cents).toBe(0);
    });

    it('regra 4, AC-1: NF-008 acusa E4 só no SKU-1025 (232 CX = 928 UN), e os itens em UN não divergem', () => {
      const found = checkUnidadeDeMedida(nf008.invoice, nf008.ctx);
      expect(found).toHaveLength(1);
      expect(found[0]?.classification).toBe('E4');
      expect(found[0]?.skus).toEqual(['SKU-1025']);
    });

    it('regra 6, AC-1: a E4 da NF-008 cita a nota (SEFAZ), a ordem (Compras) e o fator (Cadastro)', () => {
      const [e4] = checkUnidadeDeMedida(nf008.invoice, nf008.ctx);
      const sources = e4?.evidence.map((e) => e.source);
      expect(sources).toEqual(['sefaz', 'erp_compras', 'erp_cadastro']);
      expect(e4?.evidence[0]?.reference).toBe(nf008.invoice.accessKey);
      expect(e4?.evidence[0]?.description).toContain('232 CX');
      expect(e4?.evidence[1]?.reference).toBe('OC-2026-42673');
      expect(e4?.evidence[1]?.description).toContain('928 UN');
      expect(e4?.evidence[2]?.reference).toBe('SKU-1025');
      expect(e4?.evidence[2]?.description).toContain('fator de caixa 4');
    });

    it('regra 4, AC-1: sem ordem, sem item na ordem ou sem produto no cadastro a E4 não acusa (é de E5, E2 ou E8)', () => {
      const noOrder = invoiceOf({
        accessKey: '35261100000000000000550010000088881000088888',
        supplierId: 'F08',
        purchaseOrderRef: null,
        items: [{ supplierCode: 'F08-002', sku: 'SKU-1025', description: 'x', quantity: 232, unit: 'CX', unitPrice: 18.76, total: 4352.32 }],
        total: 4352.32,
      });
      expect(checkUnidadeDeMedida(noOrder, nf008.ctx)).toEqual([]);
      expect(checkUnidadeDeMedida(nf008.invoice, { ...nf008.ctx, products: [] })).toEqual([]);
      expect(checkUnidadeDeMedida(nf008.invoice, { ...nf008.ctx, purchaseOrders: [] })).toEqual([]);
    });
  });

  describe('AC-2: quantidades só se comparam na mesma unidade', () => {
    it('regra 4, AC-2: a conversão é conta, sem modelo: 12 CX com fator 4 são 48 UN', () => {
      expect(Quantity.of(12, 'CX').toUnits(4).equals(Quantity.of(48, 'UN'))).toBe(true);
    });

    it('regra 4, AC-2: NF-073 acusa só o SKU-1014; os itens de fator 12 em UN dos dois lados ficam fora', () => {
      const found = checkUnidadeDeMedida(nf073.invoice, nf073.ctx);
      expect(found).toHaveLength(1);
      expect(found[0]?.skus).toEqual(['SKU-1014']);
    });

    it('regra 4, AC-2: nota em UN contra ordem em CX também é E4, comparada em UN depois de converter', () => {
      const { invoice, ctx } = synthetic(10, 'CX', 12, 40);
      const found = checkUnidadeDeMedida(invoice, ctx);
      expect(found).toHaveLength(1);
      expect(found[0]?.skus).toEqual(['SKU-1']);
    });

    it('regra 4, AC-2: mesma unidade, mesmo com quantidade diferente, não é E4 (é de E1/E3)', () => {
      const { invoice, ctx } = synthetic(10, 'CX', 12, 40); // #67: nota 48 UN
      const sameUnit = { ...ctx, purchaseOrders: [orderOf('OC-SINT', 'F01', [{ supplierCode: 'F01-001', sku: 'SKU-1', description: 'Arroz 5 kg', quantity: 50, unit: 'UN', unitPrice: 10 }], 500)] };
      expect(checkUnidadeDeMedida(invoice, sameUnit)).toEqual([]);
    });

    it('regra 4, AC-2: acha o item da ordem e o produto pelo código do fornecedor quando a nota vem sem SKU', () => {
      const invoice = invoiceOf({
        accessKey: '35261100000000000000550010000077771000077777',
        supplierId: 'F08',
        purchaseOrderRef: 'OC-2026-42673',
        items: [{ supplierCode: 'F08-002', sku: null, description: 'Macarrão espaguete 500 g', quantity: 232, unit: 'CX', unitPrice: 18.76, total: 4352.32 }],
        total: 4352.32,
      });
      const found = checkUnidadeDeMedida(invoice, nf008.ctx);
      expect(found).toHaveLength(1);
      expect(found[0]?.skus).toEqual(['SKU-1025']);
    });
  });

  describe('AC-3: valor em risco em centavos inteiros', () => {
    it('regra 6, AC-3: NF-065, caixa convertida ao preço da ordem, tem valor em risco R$ 0,00', () => {
      const risk = e4AmountAtRisk(nf065.invoice, nf065.ctx);
      expect(risk.amount.cents).toBe(0);
      expect(risk.invoiceTotal.cents).toBe(196208);
    });

    it('regra 6, AC-3: NF-008, NF-044 e NF-067 têm valor em risco R$ 0,00', () => {
      for (const { invoice, ctx } of [nf008, nf044, nf067]) {
        expect(e4AmountAtRisk(invoice, ctx).amount.cents).toBe(0);
      }
    });

    it('regra 6, AC-3: 12 CX a R$ 50,00 contra 48 UN a R$ 10,00 põem 12000 centavos em risco', () => {
      const { invoice, ctx } = synthetic(50);
      const risk = e4AmountAtRisk(invoice, ctx);
      expect(risk.amount.cents).toBe(12000);
      expect(Number.isSafeInteger(risk.amount.cents)).toBe(true);
    });

    it('regra 6, AC-3: com a ordem em CX, o esperado é o preço da caixa sobre o fator, arredondado em centavos', () => {
      // AC-3, #67: 48 UN a R$ 12,00 contra 12 CX a R$ 40,00: esperado 48 × 4000 / 4 = 48000; cobrado 57600.
      const { invoice, ctx } = synthetic(12, 'CX', 12, 40);
      expect(e4AmountAtRisk(invoice, ctx).amount.cents).toBe(9600);
    });

    it('regra 6, AC-3: o valor em risco nunca passa do valor da nota nem fica negativo', () => {
      const { invoice, ctx } = synthetic(1); // AC-3, #67: 12 CX a R$ 1,00, abaixo do esperado
      const risk = e4AmountAtRisk(invoice, ctx);
      expect(risk.amount.cents).toBe(0);
      expect(risk.amount.compare(risk.invoiceTotal)).toBeLessThanOrEqual(0);
    });
  });

  describe('AC-4: E4 em nota até R$ 20 mil vai ao analista; acima, à coordenação', () => {
    it('limites linha 5, AC-4: NF-008 (R$ 9.463,36) vai ao analista', () => {
      expect(e4ApprovalLevel(nf008.invoice.total)).toBe('analista');
    });

    it('limites linha 4, AC-4: NF-044 (R$ 53.685,32) e NF-067 (R$ 64.034,00) vão à coordenação', () => {
      expect(e4ApprovalLevel(nf044.invoice.total)).toBe('coordenacao');
      expect(e4ApprovalLevel(nf067.invoice.total)).toBe('coordenacao');
    });

    it('limites linhas 4 e 5, AC-4: R$ 20.000,00 exatos é analista; um centavo acima é coordenação', () => {
      expect(e4ApprovalLevel(Money.ofCents(2_000_000))).toBe('analista');
      expect(e4ApprovalLevel(Money.ofCents(2_000_001))).toBe('coordenacao');
    });

    it('#110 régua: o nível do E4 vem da routeDivergences; acima de R$ 100 mil é a linha 2, diretoria', () => {
      const total = Money.ofCents(10_000_001);
      expect(e4ApprovalLevel(total)).toBe(routeDivergences([{ classification: 'E4' }], total).level);
      expect(e4ApprovalLevel(total)).toBe('diretoria');
    });
  });

  describe('AC-5: proposta aprovada com E4 publica o fator a corrigir para o Cadastro', () => {
    it('AC-5: NF-067 aprovada gera uma correção do SKU-1031 com o fator do cadastro e o observado', () => {
      const corrections = e4RegistryCorrections(nf067.invoice, proposalFor(nf067.invoice, 'E4', 'aprovada'), nf067.ctx);
      expect(corrections).toEqual([
        {
          invoiceAccessKey: '35261153194517000138550010000844441912118632',
          kind: 'E4_fator_de_caixa',
          supplierCode: 'F10-003',
          sku: 'SKU-1031',
          detail: 'SKU-1031: nota em CX, ordem em UN; fator do cadastro 4, fator observado 4',
        },
      ]);
    });

    it('AC-5: proposta alterada também publica; registrada, aguardando ou de outra classificação não', () => {
      const { invoice, ctx } = nf008;
      expect(e4RegistryCorrections(invoice, proposalFor(invoice, 'E4', 'alterada'), ctx)).toHaveLength(1);
      expect(e4RegistryCorrections(invoice, proposalFor(invoice, 'E4', 'registrada'), ctx)).toEqual([]);
      expect(e4RegistryCorrections(invoice, proposalFor(invoice, 'E4', 'aguardando_aprovacao'), ctx)).toEqual([]);
      expect(e4RegistryCorrections(invoice, proposalFor(invoice, 'E2', 'aprovada'), ctx)).toEqual([]);
    });

    it('AC-5: NF-008 aprovada publica a correção no outbox e devolve quantas publicou', async () => {
      const outbox = memoryOutbox();
      const n = await publishE4Corrections(outbox, nf008.invoice, proposalFor(nf008.invoice, 'E4', 'aprovada'), nf008.ctx);
      expect(n).toBe(1);
      expect(outbox.sent[0]?.sku).toBe('SKU-1025');
      expect(outbox.sent[0]?.detail).toBe('SKU-1025: nota em CX, ordem em UN; fator do cadastro 4, fator observado 4');
    });

    it('AC-5: proposta ainda aguardando aprovação não publica nada', async () => {
      const outbox = memoryOutbox();
      const n = await publishE4Corrections(outbox, nf044.invoice, proposalFor(nf044.invoice, 'E4', 'aguardando_aprovacao'), nf044.ctx);
      expect(n).toBe(0);
      expect(outbox.sent).toEqual([]);
    });
  });

  describe('kit carregado pelos conectores do #80 (kit_notas, kit_ordens, kit_produtos)', () => {
    const offline = async () => {
      const fake = new FakePostgrest(kitTables());
      const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
      const connectors = supabaseConnectors(rest);
      const { sefaz, purchasing, registry } = connectors.captureDeps;
      const [invoices, purchaseOrders, products] = await Promise.all([
        sefaz.listIssuedInvoices(),
        purchasing.listPurchaseOrders(),
        registry.listProducts(),
      ]);
      const ctx = emptyContext({ purchaseOrders, products });
      const invoice = (accessKey: string): Invoice => {
        const found = invoices.find((i) => i.accessKey === accessKey);
        if (found === undefined) throw new Error(`nota ${accessKey} fora do kit`);
        return found;
      };
      return { fake, outbox: connectors.registryCorrections, ctx, invoice };
    };

    it('regra 4, AC-1: NF-008 do kit acusa E4 no SKU-1025, com o fator 4 de kit_produtos', async () => {
      const { ctx, invoice } = await offline();
      const [e4, ...rest] = checkUnidadeDeMedida(invoice(nf008.invoice.accessKey), ctx);
      expect(rest).toEqual([]);
      expect(e4?.skus).toEqual(['SKU-1025']);
      expect(e4?.evidence[2]?.description).toContain('fator de caixa 4');
    });

    it('regra 4, AC-1: NF-044 do kit acusa E4 no SKU-1022 e não no SKU-1023, que vem em UN', async () => {
      const { ctx, invoice } = await offline();
      const found = checkUnidadeDeMedida(invoice(nf044.invoice.accessKey), ctx);
      expect(found.map((d) => d.skus)).toEqual([['SKU-1022']]);
    });

    it('regra 6 e limites, AC-3 e AC-4: NF-008 do kit tem R$ 0,00 em risco e vai ao analista; NF-044, à coordenação', async () => {
      const { ctx, invoice } = await offline();
      const nf008Kit = invoice(nf008.invoice.accessKey);
      const nf044Kit = invoice(nf044.invoice.accessKey);
      expect(e4AmountAtRisk(nf008Kit, ctx).amount.cents).toBe(0);
      expect(e4AmountAtRisk(nf044Kit, ctx).amount.cents).toBe(0);
      expect(e4ApprovalLevel(nf008Kit.total)).toBe('analista');
      expect(e4ApprovalLevel(nf044Kit.total)).toBe('coordenacao');
    });

    it('AC-5: a correção da E4 é uma RegistryCorrectionMessage e o RegistryCorrectionOutbox do #80 é o porto da E4', async () => {
      const { fake, outbox, ctx, invoice } = await offline();
      // AC-5, #67: prova em tempo de compilação; o domínio não importa de connectors.
      const port: E4CorrectionOutbox = outbox satisfies RegistryCorrectionOutbox;
      const nf044Kit = invoice(nf044.invoice.accessKey);
      const approved = proposalFor(nf044Kit, 'E4', 'aprovada');
      const asMessages: readonly RegistryCorrectionMessage[] = e4RegistryCorrections(nf044Kit, approved, ctx);
      expect(asMessages).toHaveLength(1);
      const n = await publishE4Corrections(port, nf044Kit, proposalFor(nf044Kit, 'E4', 'aprovada'), ctx);
      expect(n).toBe(1);
      const expected: RegistryCorrectionMessage = {
        invoiceAccessKey: nf044Kit.accessKey,
        kind: 'E4_fator_de_caixa',
        supplierCode: 'F07-001',
        sku: 'SKU-1022',
        detail: 'SKU-1022: nota em CX, ordem em UN; fator do cadastro 4, fator observado 4',
      };
      expect(await outbox.list()).toMatchObject([expected]);
      expect(fake.rows('outbox_registry_corrections')).toHaveLength(1);
    });
  });
});
