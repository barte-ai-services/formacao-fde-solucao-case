import { AmountAtRisk } from '../amount-at-risk.js';
import { routeDivergences } from '../approval-policy.js';
import type { ApprovalLevel } from '../approval-level.js';
import type { CheckContext, Product, PurchaseOrder, PurchaseOrderItem } from '../context.js';
import { Divergence } from '../divergence.js';
import type { Evidence } from '../evidence.js';
import type { InvoiceItem, InvoiceView } from '../invoice.js';
import { Money } from '../money.js';
import type { Proposal } from '../proposal.js';
import type { Quantity } from '../quantity.js';
import type { Check } from './check.js';

/** Regra 4, #67: um item da nota cobrado numa unidade diferente da ordem, com o fator do cadastro. */
type E4Line = {
  readonly item: InvoiceItem;
  readonly orderItem: PurchaseOrderItem;
  readonly product: Product;
  /** Regra 4, AC-2, #67: a quantidade da nota já em UN, pelo fator do cadastro. */
  readonly invoicedUnits: Quantity;
  /** Regra 4, AC-2, #67: a quantidade da ordem já em UN, pelo fator do cadastro. */
  readonly orderedUnits: Quantity;
};

const findOrder = (invoice: InvoiceView, ctx: CheckContext): PurchaseOrder | undefined =>
  invoice.purchaseOrderRef === null ? undefined : ctx.purchaseOrders.find((o) => o.id === invoice.purchaseOrderRef);

/** Regra 4, AC-2, #67: o item da ordem pelo SKU; sem SKU que case, pelo código do fornecedor. */
const findOrderItem = (order: PurchaseOrder, item: InvoiceItem): PurchaseOrderItem | undefined =>
  (item.sku === null ? undefined : order.items.find((o) => o.sku === item.sku)) ??
  order.items.find((o) => o.supplierCode === item.supplierCode);

/** Regra 4, AC-2, #67: o produto pelo SKU; sem SKU que case, pelo fornecedor e código do fornecedor. */
const findProduct = (invoice: InvoiceView, item: InvoiceItem, ctx: CheckContext): Product | undefined =>
  (item.sku === null ? undefined : ctx.products.find((p) => p.sku === item.sku)) ??
  ctx.products.find((p) => p.supplierId === invoice.supplierId && p.supplierCode === item.supplierCode);

/**
 * Regra 4, #67: os itens da nota em unidade diferente da ordem. Sem ordem (E5), sem item na ordem (E2) ou
 * sem produto no cadastro (E8) o item fica para a verificação dona. As quantidades só se comparam em
 * UN, depois da conversão pelo fator, que é conta e não modelo (AC-2).
 */
const e4Lines = (invoice: InvoiceView, ctx: CheckContext): readonly E4Line[] => {
  const order = findOrder(invoice, ctx);
  if (order === undefined) return [];
  const lines: E4Line[] = [];
  for (const item of invoice.items) {
    const orderItem = findOrderItem(order, item);
    const product = findProduct(invoice, item, ctx);
    if (orderItem === undefined || product === undefined) continue;
    if (item.quantity.unit === orderItem.quantity.unit) continue;
    lines.push({
      item,
      orderItem,
      product,
      invoicedUnits: item.quantity.toUnits(product.boxFactor),
      orderedUnits: orderItem.quantity.toUnits(product.boxFactor),
    });
  }
  return lines;
};

const skuOf = (line: E4Line): string => line.product.sku;

const evidenceOf = (invoice: InvoiceView, order: string, line: E4Line): readonly Evidence[] => {
  const sku = skuOf(line);
  const { item, orderItem, product } = line;
  return [
    {
      source: 'sefaz',
      reference: invoice.accessKey,
      description: `Item ${sku} na nota: ${item.quantity.amount} ${item.quantity.unit} a ${item.unitPrice.toString()}`,
    },
    {
      source: 'erp_compras',
      reference: order,
      description: `Item ${sku} na ordem: ${orderItem.quantity.amount} ${orderItem.quantity.unit} a ${orderItem.unitPrice.toString()}`,
    },
    {
      source: 'erp_cadastro',
      reference: sku,
      description:
        `Produto ${sku}: fator de caixa ${product.boxFactor}; ` +
        `nota ${line.invoicedUnits.amount} UN, ordem ${line.orderedUnits.amount} UN`,
    },
  ];
};

/**
 * E4 — unidade de medida: caixa e unidade trocadas.
 * Regra que rege: regras 4 e 6.
 * Dona: plano #67 (história #37).
 *
 * Unidade da nota diferente da unidade da ordem, com o fator conhecido no cadastro, é E4, e não
 * diferença de preço (regra 4). Devolve uma divergência por nota, com todos os SKUs afetados e, para
 * cada um, a nota (SEFAZ), a ordem (Compras) e o fator (Cadastro) como evidência (regra 6).
 * Decisão do #67: é E4 mesmo se a quantidade convertida não bater, senão a checagem de preço compararia
 * preço por CX com preço por UN.
 */
export const checkUnidadeDeMedida: Check = (invoice, ctx) => { // ADR-002
  const lines = e4Lines(invoice, ctx);
  const order = invoice.purchaseOrderRef;
  if (lines.length === 0 || order === null) return [];
  return [
    Divergence.of({
      classification: 'E4',
      skus: lines.map(skuOf),
      evidence: lines.flatMap((l) => evidenceOf(invoice, order, l)),
    }),
  ];
};

/**
 * Regra 6, AC-3: quanto a nota cobra além do que a ordem pagaria pelas mesmas unidades, em centavos
 * inteiros. Por item E4, o esperado é o preço da ordem sobre as unidades cobradas, limitadas às da
 * ordem; com a ordem em CX, o preço da caixa sobre o fator, arredondado ao centavo. O risco do item é
 * o que passa do esperado, nunca negativo; a soma fica entre zero e o valor da nota.
 */
export function e4AmountAtRisk(invoice: InvoiceView, ctx: CheckContext): AmountAtRisk {
  let risk = Money.zero();
  for (const line of e4Lines(invoice, ctx)) {
    const units = Math.min(line.invoicedUnits.amount, line.orderedUnits.amount);
    const price = line.orderItem.unitPrice.cents;
    const expected = Money.ofCents(
      line.orderItem.quantity.unit === 'CX'
        ? Math.round((price * units) / line.product.boxFactor)
        : Math.round(price * units),
    );
    const over = line.item.total.subtract(expected);
    if (!over.isNegative()) risk = risk.add(over);
  }
  return AmountAtRisk.of(risk.compare(invoice.total) > 0 ? invoice.total : risk, invoice.total);
}

/**
 * Limites de aprovação, linhas 4 e 5, AC-4: E4 em nota de até R$ 20 mil (inclusive) vai ao analista;
 * acima, à coordenação. As linhas 1 e 2 (duplicidade, nota acima de R$ 100 mil, fornecedor com
 * pagamento bloqueado) e o maior nível entre as divergências da nota (regra 7) são da política geral
 * de aprovação, não deste plano: ela combina este nível com os demais.
 */
export function e4ApprovalLevel(invoiceTotal: Money): ApprovalLevel {
  // #110: a régua (#63) é a fonte única do encaminhamento; não há limite de valor aqui.
  return routeDivergences([{ classification: 'E4' }], invoiceTotal).level;
}

/**
 * AC-5: a correção de fator de caixa que a Conferência publica para o Cadastro. É estruturalmente
 * uma `RegistryCorrectionMessage` (connectors/ports.ts, #80); o domínio não importa de connectors, e
 * o teste da E4 prova a compatibilidade.
 */
export type E4RegistryCorrection = {
  readonly invoiceAccessKey: string;
  readonly kind: 'E4_fator_de_caixa';
  readonly supplierCode: string;
  readonly sku: string | null;
  readonly detail: string;
};

/** AC-5, #67: o fator que a nota e a ordem mostram, unidades do lado em UN sobre caixas do lado em CX. */
const observedFactor = (line: E4Line): string => {
  const [boxes, units] =
    line.item.quantity.unit === 'CX'
      ? [line.item.quantity.amount, line.orderItem.quantity.amount]
      : [line.orderItem.quantity.amount, line.item.quantity.amount];
  const factor = units / boxes;
  return boxes !== 0 && Number.isInteger(factor) ? `${factor}` : `não inteiro (${units} UN para ${boxes} CX)`;
};

const isDecided = (proposal: Proposal): boolean =>
  proposal.state === 'aprovada' || proposal.state === 'alterada';

/**
 * AC-5: com a proposta E4 aprovada (ou alterada), uma correção por SKU afetado, com a unidade da nota,
 * a da ordem, o fator do cadastro e o fator observado. Antes da aprovação, ou em outra classificação,
 * nada.
 */
export function e4RegistryCorrections(
  invoice: InvoiceView,
  proposal: Proposal,
  ctx: CheckContext,
): readonly E4RegistryCorrection[] {
  if (proposal.classification !== 'E4' || !isDecided(proposal)) return [];
  return e4Lines(invoice, ctx).map((line) => ({
    invoiceAccessKey: invoice.accessKey,
    kind: 'E4_fator_de_caixa',
    supplierCode: line.item.supplierCode,
    sku: skuOf(line),
    detail:
      `${skuOf(line)}: nota em ${line.item.quantity.unit}, ordem em ${line.orderItem.quantity.unit}; ` +
      `fator do cadastro ${line.product.boxFactor}, fator observado ${observedFactor(line)}`,
  }));
}

/** O porto de saída para o Cadastro. O `RegistryCorrectionOutbox` do #80 cabe aqui; o teste da E4 prova. */
export type E4CorrectionOutbox = {
  publish(message: E4RegistryCorrection): Promise<unknown>;
};

/** AC-5: publica, em ordem, cada correção da proposta aprovada e devolve quantas publicou. */
export async function publishE4Corrections(
  outbox: E4CorrectionOutbox,
  invoice: InvoiceView,
  proposal: Proposal,
  ctx: CheckContext,
): Promise<number> {
  const corrections = e4RegistryCorrections(invoice, proposal, ctx);
  for (const correction of corrections) {
    await outbox.publish(correction);
  }
  return corrections.length;
}
