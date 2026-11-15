import { withinTolerance } from '../approval-policy.js';
import { Divergence } from '../divergence.js';
import type { Evidence } from '../evidence.js';
import { Money } from '../money.js';
import type { CheckContext } from '../context.js';
import type { InvoiceView } from '../invoice.js';
import type { Check } from './check.js';

/**
 * NAO_CATALOGADA — não catalogada: divergência que não cabe em E1 a E8.
 * Regra que rege: regras 4 e 6 (roda por último).
 * Dona: plano #63 (limites e aprovação; decisão 3: diferença de preço fora da tolerância).
 *
 * #63: soma, item a item, a diferença entre o que a nota cobra e a quantidade da nota pelo preço da
 * ordem.
 */
/** #63: a diferença de preço da nota contra a ordem, item a item, e quanto dela é cobrança a mais. */
export type PriceDifference = {
  readonly orderId: string;
  /** Soma das diferenças, para cima ou para baixo: o que a tolerância mede. */
  readonly difference: Money;
  /** Só o que a nota cobra acima da ordem: o valor em risco da não catalogada. */
  readonly overcharge: Money;
  readonly skus: readonly string[];
  readonly evidence: readonly Evidence[];
};

/**
 * Compara só itens que estão na ordem e na mesma unidade: item fora da ordem é E2 ou E8, e caixa
 * contra unidade é E4, não diferença de preço (regra 4). Sem ordem, nulo (é E5).
 */
export function priceDifference(invoice: InvoiceView, ctx: CheckContext): PriceDifference | null {
  const order = ctx.purchaseOrders.find((o) => o.id === invoice.purchaseOrderRef);
  if (!order) return null;

  let difference = Money.zero();
  let overcharge = Money.zero();
  const skus: string[] = [];
  const evidence: Evidence[] = [];
  for (const item of invoice.items) {
    const ordered = order.items.find((o) => o.supplierCode === item.supplierCode);
    if (!ordered || ordered.quantity.unit !== item.quantity.unit) continue;
    const expected = Money.ofCents(Math.round(item.quantity.amount * ordered.unitPrice.cents));
    const delta = item.total.subtract(expected);
    if (delta.isZero()) continue;
    difference = difference.add(delta.isNegative() ? Money.zero().subtract(delta) : delta);
    if (!delta.isNegative()) overcharge = overcharge.add(delta);
    if (item.sku) skus.push(item.sku);
    evidence.push({
      source: 'erp_compras',
      reference: `${order.id}/${item.supplierCode}`,
      description:
        `${item.description}: a nota cobra ${item.total.toString()}; pela ordem, ` +
        `${item.quantity.amount} ${item.quantity.unit} a ${ordered.unitPrice.toString()} dão ${expected.toString()}`,
    });
  }
  return { orderId: order.id, difference, overcharge, skus, evidence };
}

/**
 * Dentro da tolerância da linha 6, não há divergência; fora dela, é não catalogada e vai à
 * coordenação (AC-2 da #32).
 */
export const checkNaoCatalogada: Check = (invoice, ctx) => { // ADR-002
  const found = priceDifference(invoice, ctx);
  if (!found || withinTolerance(found.difference, invoice.total)) return [];
  const evidence: Evidence[] = [
    {
      source: 'sefaz',
      reference: invoice.accessKey,
      description: `Diferença de preço de ${found.difference.toString()} contra a ordem ${found.orderId}, fora da tolerância (R$ 50 e 0,5% em nota de até R$ 5 mil)`,
    },
    ...found.evidence,
  ];
  return [Divergence.of({ classification: 'NAO_CATALOGADA', skus: found.skus, evidence })];
};
