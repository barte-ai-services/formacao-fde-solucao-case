import { Divergence } from '../divergence.js';
import type { Evidence } from '../evidence.js';
import { assessCount, missingItems, orderOf } from '../reconciliation.js';
import type { Check } from './check.js';

/**
 * E1 — falta física: a contagem ficou abaixo do faturado.
 * Regra que rege: regras 4 e 6.
 * Dona: plano #69 (história #44).
 *
 * #69/AC-2: o item da nota que não aparece na contagem ligada pela chave é E1. Uma divergência por
 * nota, com os SKUs que faltam; a evidência é o recebimento do WMS e, se houver, a ordem de compra.
 * Chegar a menos é E3 (#73). Sem contagem, não há E1: a nota espera (AC-5).
 */
export const checkFaltaFisica: Check = (invoice, ctx) => {
  const assessment = assessCount(invoice, ctx);
  if (assessment.status === 'no_count') return [];
  const missing = missingItems(invoice, assessment.lines);
  if (missing.length === 0) return [];

  const detail = missing
    .map(({ item, line }) => `${item.description} (${line.invoiced.amount} ${line.invoiced.unit}, ${item.total.toString()})`)
    .join('; ');
  const evidence: Evidence[] = [
    {
      source: 'wms',
      reference: assessment.receipt.id,
      description: `Não aparece na contagem: ${detail}`,
    },
  ];
  const order = orderOf(invoice, ctx.purchaseOrders);
  if (order) {
    evidence.push({
      source: 'erp_compras',
      reference: order.id,
      description: `A ordem pede os itens que não chegaram: ${missing.map(({ item }) => item.supplierCode).join(', ')}`,
    });
  }
  return [
    Divergence.of({
      classification: 'E1',
      skus: missing.map(({ item }) => item.sku ?? item.supplierCode),
      evidence,
    }),
  ];
};
