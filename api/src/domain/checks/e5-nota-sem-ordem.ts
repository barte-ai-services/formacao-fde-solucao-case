import type { CheckContext } from '../context.js';
import { Divergence } from '../divergence.js';
import type { InvoiceView } from '../invoice.js';
import type { Check } from './check.js';

/**
 * #34/AC-1: a nota cita uma ordem que Compras tem. A mesma condição decide a E5 e quais notas a
 * tarefa da ordem provável pede ao Claude, para as duas nunca divergirem.
 */
export function citesKnownOrder(invoice: Pick<InvoiceView, 'purchaseOrderRef'>, ctx: Pick<CheckContext, 'purchaseOrders'>): boolean {
  const ref = invoice.purchaseOrderRef?.trim() ?? '';
  return ref !== '' && ctx.purchaseOrders.some((o) => o.id === ref);
}

/**
 * E5 — nota sem ordem de compra.
 * Regra que rege: regras 5 e 6.
 * Dona: plano #65 (história #34).
 *
 * #34/AC-1: a nota sem referência de ordem, ou que cita uma ordem que Compras não tem, é E5.
 * Regra 6: a divergência cita a nota na SEFAZ e a ausência da ordem em Compras.
 */
export const checkNotaSemOrdem: Check = (invoice, ctx) => {
  // ADR-002
  if (citesKnownOrder(invoice, ctx)) return [];
  const ref = invoice.purchaseOrderRef?.trim() ?? '';

  const cited = ref !== '';
  return [
    Divergence.of({
      classification: 'E5',
      skus: invoice.items.map((i) => i.sku).filter((sku): sku is string => sku !== null),
      evidence: [
        {
          source: 'sefaz',
          reference: invoice.accessKey,
          description: cited
            ? `A nota ${invoice.number} cita a ordem ${ref}`
            : `A nota ${invoice.number} veio sem ordem de compra`,
        },
        {
          source: 'erp_compras',
          reference: cited ? ref : 'sem referência',
          description: cited ? `Compras não tem a ordem ${ref}` : 'Compras não tem ordem para esta nota',
        },
      ],
    }),
  ];
};
