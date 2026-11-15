import {
  AmountAtRisk,
  DockAction,
  Divergence,
  Invoice,
  Money,
  Proposal,
  Quantity,
  type CheckContext,
} from '../../src/domain/index.js';
import { anInvoice, emptyContext } from '../domain/fixtures.js';

// #68: a nota da fixture com uma divergência real (E1, falta física) e o contexto que a sustenta.

export const ACCESS_KEY = '35261100000000000000550010000012341000012345';

export const dossierContext = (): CheckContext =>
  emptyContext({
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
            quantity: Quantity.of(12, 'CX'),
            unitPrice: Money.ofCents(10000),
            balance: Quantity.of(12, 'CX'),
          },
        ],
        total: Money.ofCents(120000),
      },
    ],
    suppliers: [
      {
        id: 'F-001',
        legalName: 'Distribuidora Exemplo',
        cnpj: '12.345.678/0001-90',
        paymentBlocked: false,
        blockReason: '',
      },
    ],
    products: [
      {
        sku: 'SKU-1',
        description: 'Arroz 5kg',
        supplierId: 'F-001',
        supplierCode: 'A1',
        baseUnit: 'UN',
        boxFactor: 4,
        referenceUnitPrice: Money.ofCents(2500),
      },
    ],
    postedInvoices: [
      {
        accessKey: 'K-ANTIGA-1',
        number: '1100',
        supplierId: 'F-001',
        purchaseOrderRef: 'OC-090',
        total: Money.ofCents(50000),
        status: 'pago',
      },
      {
        accessKey: 'K-ANTIGA-2',
        number: '1101',
        supplierId: 'F-001',
        purchaseOrderRef: 'OC-091',
        total: Money.ofCents(70000),
        status: 'pago',
      },
      {
        accessKey: 'K-OUTRO',
        number: '9',
        supplierId: 'F-999',
        purchaseOrderRef: null,
        total: Money.ofCents(99900),
        status: 'pago',
      },
    ],
    payments: [
      {
        id: 'P-1',
        supplierId: 'F-001',
        store: 'L01',
        paidOn: '2026-10-20',
        amount: Money.ofCents(50000),
        method: 'boleto',
        origin: 'fluxo',
        invoiceAccessKey: 'K-ANTIGA-1',
      },
    ],
    receipts: [
      {
        id: 'R-1',
        invoiceAccessKey: ACCESS_KEY,
        purchaseOrderId: 'OC-100',
        supplierId: 'F-001',
        store: 'L01',
        receivedOn: '2026-11-11',
        items: [{ supplierCode: 'A1', description: 'Arroz 5kg', quantity: Quantity.of(10, 'CX') }],
        note: 'faltaram duas caixas',
      },
    ],
  });

export const e1Divergence = (): Divergence =>
  Divergence.of({
    classification: 'E1',
    skus: ['SKU-1'],
    evidence: [
      { source: 'wms', reference: 'R-1', description: 'contagem de 10 CX para 12 CX faturadas' },
      { source: 'sefaz', reference: ACCESS_KEY, description: 'nota com 12 CX' },
    ],
  });

/** A nota conferida, com a divergência E1. */
export const checkedInvoice = (): Invoice => {
  const invoice = anInvoice(ACCESS_KEY);
  invoice.check(dossierContext(), [{ id: 'E1', run: () => [e1Divergence()] }]);
  return invoice;
};

/** Proposta acima do nível regra, já encaminhada a uma pessoa. */
export const awaitingProposal = (): Proposal => {
  const p = Proposal.register({
    classification: 'E1',
    dockAction: DockAction.partial([
      { sku: 'SKU-1', quantity: Quantity.of(2, 'CX'), disposition: 'devolver' },
    ]),
    level: 'analista',
    amountAtRisk: AmountAtRisk.of(Money.ofCents(20000), Money.ofCents(120000)),
    justification: 'faltaram duas caixas na contagem',
  });
  p.awaitApproval();
  return p;
};

/** Uma resposta do Claude bem formada: todo número por marcador do catálogo. */
export const goodRaw = () => ({
  summary:
    'A nota cobra {{nota.item[A1].quantidade}} de SKU-1, mas o recebimento R-1 contou {{recebimento[R-1].item[A1].quantidade}}.',
  divergences: [
    {
      classification: 'E1',
      what_diverges:
        'Faltaram caixas: a nota fatura {{nota.item[A1].quantidade}} a {{nota.item[A1].preco_unitario}} e a contagem achou {{recebimento[R-1].item[A1].quantidade}}.',
      evidence: ['nota.item[A1].quantidade', 'recebimento[R-1].item[A1].quantidade'],
    },
  ],
  supplier_history:
    'O fornecedor F-001 tem {{historico.notas_lancadas.quantidade}} notas lançadas, somando {{historico.notas_lancadas.valor}}, e {{historico.pagamentos.quantidade}} pagamento.',
});
