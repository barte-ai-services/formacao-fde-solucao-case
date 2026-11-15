import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvalLevelItemTrocado,
  amountAtRiskItemTrocado,
  checkItemTrocado,
} from '../../src/domain/checks/e2-item-trocado.js';
import { matchByDescription } from '../../src/domain/description-match.js';
import {
  Invoice,
  Money,
  Quantity,
  type InvoiceItem,
  type Product,
  type PurchaseOrder,
  type PurchaseOrderItem,
} from '../../src/domain/index.js';
import { emptyContext } from './fixtures.js';

// #70: o casamento por descrição é do #66. Aqui ele é um dublê, para o teste valer com o stub e com o real.
vi.mock('../../src/domain/description-match.js', () => ({
  matchByDescription: vi.fn((): number | null => null),
}));
const fakeMatch = vi.mocked(matchByDescription);

const cents = (reais: number) => Money.fromReais(reais);

const invItem = (supplierCode: string, sku: string | null, description: string, total: number): InvoiceItem => ({
  supplierCode,
  sku,
  description,
  quantity: Quantity.of(1, 'UN'),
  unitPrice: cents(total),
  total: cents(total),
});

const poItem = (supplierCode: string, sku: string | null, description: string): PurchaseOrderItem => ({
  sku,
  supplierCode,
  description,
  quantity: Quantity.of(1, 'UN'),
  unitPrice: cents(1),
  balance: Quantity.of(1, 'UN'),
});

const order = (id: string, supplierId: string, items: PurchaseOrderItem[]): PurchaseOrder => ({
  id,
  supplierId,
  store: 'LJ-012',
  issuedOn: '2026-11-01',
  status: 'aberta', // ADR-002
  statusReason: '',
  items,
  total: cents(1),
});

const product = (sku: string, description: string, supplierId: string, supplierCode: string): Product => ({
  sku,
  description,
  supplierId,
  supplierCode,
  baseUnit: 'UN',
  boxFactor: 1,
  referenceUnitPrice: cents(1),
});

const invoice = (opts: {
  supplierId: string;
  ref: string | null;
  items: InvoiceItem[];
  total: number;
}): Invoice =>
  Invoice.receive({
    accessKey: '35261174055489000148550010000438941174512643',
    number: '43894',
    series: '1',
    supplierId: opts.supplierId,
    store: 'LJ-012',
    issuedOn: '2026-11-09',
    purchaseOrderRef: opts.ref,
    entryChannel: 'SEFAZ',
    items: opts.items,
    total: cents(opts.total),
  });

// NF-001 da base do kit: F02-001 (Água mineral) veio no lugar de F02-003 (Suco de uva) da OC-2026-42328.
const nf001 = () =>
  invoice({
    supplierId: 'F02',
    ref: 'OC-2026-42328',
    items: [
      invItem('F02-002', 'SKU-1006', 'Refrigerante cola 2 L', 611.28),
      invItem('F02-004', 'SKU-1008', 'Água de coco 1 L', 271.6),
      invItem('F02-001', 'SKU-1005', 'Água mineral 1,5 L', 535.68),
    ],
    total: 1418.56,
  });

const ctxF02 = (poItems?: PurchaseOrderItem[]) =>
  emptyContext({
    purchaseOrders: [
      order(
        'OC-2026-42328',
        'F02',
        poItems ?? [
          poItem('F02-002', 'SKU-1006', 'Refrigerante cola 2 L'),
          poItem('F02-004', 'SKU-1008', 'Água de coco 1 L'),
          poItem('F02-003', 'SKU-1007', 'Suco de uva integral 1 L'),
        ],
      ),
    ],
    products: [
      product('SKU-1005', 'Água mineral 1,5 L', 'F02', 'F02-001'),
      product('SKU-1006', 'Refrigerante cola 2 L', 'F02', 'F02-002'),
      product('SKU-1007', 'Suco de uva integral 1 L', 'F02', 'F02-003'),
      product('SKU-1008', 'Água de coco 1 L', 'F02', 'F02-004'),
    ],
  });

// NF-063 da base do kit: F06-002 (Pizza) veio no lugar de F06-003 (Sorvete), nota de R$ 64.078,80.
const nf063 = () =>
  invoice({
    supplierId: 'F06',
    ref: 'OC-2026-42387',
    items: [
      invItem('F06-001', 'SKU-1019', 'Pão de queijo congelado 1 kg', 35258.4),
      invItem('F06-002', 'SKU-1020', 'Pizza congelada 460 g', 28820.4),
    ],
    total: 64078.8,
  });

const ctxF06 = () =>
  emptyContext({
    purchaseOrders: [
      order('OC-2026-42387', 'F06', [
        poItem('F06-003', 'SKU-1021', 'Sorvete 1,5 L'),
        poItem('F06-001', 'SKU-1019', 'Pão de queijo congelado 1 kg'),
      ]),
    ],
    products: [
      product('SKU-1019', 'Pão de queijo congelado 1 kg', 'F06', 'F06-001'),
      product('SKU-1020', 'Pizza congelada 460 g', 'F06', 'F06-002'),
      product('SKU-1021', 'Sorvete 1,5 L', 'F06', 'F06-003'),
    ],
  });

beforeEach(() => {
  fakeMatch.mockReset();
  fakeMatch.mockImplementation(() => null);
});

describe('#36 E2 item trocado', () => {
  it('#36/AC-1 regra 6: item cadastrado fora da ordem, no lugar de um que está nela, é E2 (NF-001)', () => {
    const found = checkItemTrocado(nf001(), ctxF02());
    expect(found).toHaveLength(1);
    expect(found[0]?.classification).toBe('E2');
    expect(found[0]?.skus).toEqual(['SKU-1005']);
  });

  it('#36/AC-1 regra 6: a evidência cita a ordem no ERP Compras e o produto no ERP Cadastro', () => {
    const [d] = checkItemTrocado(nf001(), ctxF02());
    expect(d?.evidence.map((e) => [e.source, e.reference])).toEqual([
      ['erp_compras', 'OC-2026-42328'],
      ['erp_cadastro', 'SKU-1005'],
    ]);
    expect(d?.evidence[0]?.description).toContain('Suco de uva integral 1 L');
    expect(d?.evidence[0]?.description).toContain('Água mineral 1,5 L');
  });

  it('#36/AC-1 regra 6: nota sem ordem referenciada não é E2 (é a E5)', () => {
    const nota = invoice({ supplierId: 'F02', ref: null, items: nf001().items.slice(), total: 1418.56 });
    expect(checkItemTrocado(nota, ctxF02())).toEqual([]);
  });

  it('#36/AC-1 regra 6: ordem referenciada que não existe não é E2 (é a E5)', () => {
    expect(checkItemTrocado(nf001(), emptyContext({ products: ctxF02().products }))).toEqual([]);
  });

  it('#36/AC-1 regra 6: nota que bate com a ordem não é E2', () => {
    const nota = invoice({
      supplierId: 'F02',
      ref: 'OC-2026-42328',
      items: [
        invItem('F02-002', 'SKU-1006', 'Refrigerante cola 2 L', 611.28),
        invItem('F02-004', 'SKU-1008', 'Água de coco 1 L', 271.6),
        invItem('F02-003', 'SKU-1007', 'Suco de uva integral 1 L', 536.4),
      ],
      total: 1419.28,
    });
    expect(checkItemTrocado(nota, ctxF02())).toEqual([]);
  });

  it('#36/AC-1 regra 6: item de ordem sem SKU ainda casa pelo código do fornecedor', () => {
    const ctx = ctxF02([
      poItem('F02-002', null, 'Refrigerante cola 2 L'),
      poItem('F02-004', 'SKU-1008', 'Água de coco 1 L'),
      poItem('F02-001', null, 'Água mineral 1,5 L'),
    ]);
    expect(checkItemTrocado(nf001(), ctx)).toEqual([]);
  });

  it('#36/AC-1 regra 6: SKU nulo na nota e na ordem não casa por SKU', () => {
    const nota = invoice({
      supplierId: 'F02',
      ref: 'OC-2026-42328',
      items: [invItem('F02-001', null, 'Água mineral 1,5 L', 535.68)],
      total: 535.68,
    });
    const ctx = ctxF02([poItem('F02-003', null, 'Suco de uva integral 1 L')]);
    const found = checkItemTrocado(nota, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]?.skus).toEqual(['SKU-1005']);
  });

  it('#36/AC-1 regra 6: item casa pelo SKU quando o código do fornecedor difere', () => {
    const ctx = ctxF02([
      poItem('F02-002', 'SKU-1006', 'Refrigerante cola 2 L'),
      poItem('F02-004', 'SKU-1008', 'Água de coco 1 L'),
      poItem('X-001', 'SKU-1005', 'Água mineral 1,5 L'),
    ]);
    expect(checkItemTrocado(nf001(), ctx)).toEqual([]);
  });

  it('#36/AC-1 regra 6: código trocado pelo fornecedor com a mesma descrição não é E2', () => {
    fakeMatch.mockImplementation((description, candidates) => {
      const i = candidates.indexOf(description);
      return i >= 0 ? i : null;
    });
    const ctx = ctxF02([
      poItem('F02-002', 'SKU-1006', 'Refrigerante cola 2 L'),
      poItem('F02-004', 'SKU-1008', 'Água de coco 1 L'),
      poItem('F02-009', 'SKU-9999', 'Água mineral 1,5 L'),
    ]);
    expect(checkItemTrocado(nf001(), ctx)).toEqual([]);
  });

  it('#36/AC-1 regra 6: o casamento por descrição não rouba o item que outro casa pelo código', () => {
    // O dublê casa tudo com o primeiro candidato; se o F02-002 da ordem estivesse livre, a água o levaria.
    fakeMatch.mockImplementation((_d, candidates) => (candidates.length > 0 ? 0 : null));
    const nota = invoice({
      supplierId: 'F02',
      ref: 'OC-2026-42328',
      items: [
        invItem('F02-001', 'SKU-1005', 'Água mineral 1,5 L', 535.68),
        invItem('F02-002', 'SKU-1006', 'Refrigerante cola 2 L', 611.28),
      ],
      total: 1146.96,
    });
    const ctx = ctxF02([poItem('F02-002', 'SKU-1006', 'Refrigerante cola 2 L')]);
    // Água fica sem item de ordem livre: é item a mais, não troca.
    expect(checkItemTrocado(nota, ctx)).toEqual([]);
    expect(fakeMatch).toHaveBeenCalledTimes(0);
  });

  it('#36/AC-1 regra 6: o casamento por descrição só vê os itens de ordem ainda livres', () => {
    fakeMatch.mockImplementation(() => null);
    checkItemTrocado(nf001(), ctxF02());
    expect(fakeMatch).toHaveBeenCalledWith('Água mineral 1,5 L', ['Suco de uva integral 1 L']);
  });

  it('#36/AC-1 regra 6: item sem cadastro fora da ordem não é E2 (é a E8)', () => {
    const ctx = { ...ctxF02(), products: ctxF02().products.filter((p) => p.sku !== 'SKU-1005') };
    expect(checkItemTrocado(nf001(), ctx)).toEqual([]);
  });

  it('#36/AC-1 regra 6: cadastro de outro fornecedor não torna o item cadastrado', () => {
    const ctx = {
      ...ctxF02(),
      products: [
        ...ctxF02().products.filter((p) => p.sku !== 'SKU-1005'),
        product('SKU-1005', 'Água mineral 1,5 L', 'F99', 'F02-001'),
      ],
    };
    expect(checkItemTrocado(nf001(), ctx)).toEqual([]);
  });

  it('#36/AC-1 regra 6: item cadastrado a mais, sem nada faltando na ordem, não é E2', () => {
    const ctx = ctxF02([
      poItem('F02-002', 'SKU-1006', 'Refrigerante cola 2 L'),
      poItem('F02-004', 'SKU-1008', 'Água de coco 1 L'),
    ]);
    expect(checkItemTrocado(nf001(), ctx)).toEqual([]);
  });

  it('#36/AC-2 regra 6: o valor em risco da E2 é o valor do item trocado (NF-001, R$ 535,68)', () => {
    const risk = amountAtRiskItemTrocado(nf001(), ctxF02());
    expect(risk.amount.cents).toBe(53568);
    expect(risk.invoiceTotal.cents).toBe(141856);
  });

  it('#36/AC-2 regra 6: o valor em risco soma os itens trocados', () => {
    const nota = invoice({
      supplierId: 'F02',
      ref: 'OC-2026-42328',
      items: [
        invItem('F02-001', 'SKU-1005', 'Água mineral 1,5 L', 535.68),
        invItem('F02-004', 'SKU-1008', 'Água de coco 1 L', 271.6),
      ],
      total: 807.28,
    });
    const ctx = ctxF02([
      poItem('F02-002', 'SKU-1006', 'Refrigerante cola 2 L'),
      poItem('F02-003', 'SKU-1007', 'Suco de uva integral 1 L'),
    ]);
    expect(checkItemTrocado(nota, ctx)).toHaveLength(2);
    expect(amountAtRiskItemTrocado(nota, ctx).amount.cents).toBe(80728);
  });

  it('#36/AC-2 regra 6: sem E2, o valor em risco é zero', () => {
    expect(amountAtRiskItemTrocado(nf001(), emptyContext()).amount.isZero()).toBe(true);
  });

  it('#36/AC-2 regra 6: o valor em risco da NF-063 é o da pizza, R$ 28.820,40', () => {
    expect(amountAtRiskItemTrocado(nf063(), ctxF06()).amount.cents).toBe(2882040);
    expect(checkItemTrocado(nf063(), ctxF06())[0]?.skus).toEqual(['SKU-1020']);
  });

  it('#36/AC-3 regras 4 e 5: E2 em nota de até R$ 20 mil vai ao analista (NF-001)', () => {
    expect(approvalLevelItemTrocado(nf001())).toBe('analista');
  });

  it('#36/AC-3 regras 4 e 5: E2 em nota acima de R$ 20 mil vai à coordenação (NF-063)', () => {
    expect(approvalLevelItemTrocado(nf063())).toBe('coordenacao');
  });

  it('#36/AC-3 regras 4 e 5: nota de exatamente R$ 20.000,00 fica com o analista', () => {
    const nota = invoice({ supplierId: 'F02', ref: null, items: [], total: 20000 });
    expect(approvalLevelItemTrocado(nota)).toBe('analista');
  });

  it('#36/AC-3 regras 4 e 5: nota de R$ 20.000,01 vai à coordenação', () => {
    const nota = invoice({ supplierId: 'F02', ref: null, items: [], total: 20000.01 });
    expect(approvalLevelItemTrocado(nota)).toBe('coordenacao');
  });
});
