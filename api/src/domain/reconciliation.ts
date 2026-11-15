import type { Product, Receipt } from './context.js';
import type { Invoice } from './invoice.js';
import type { Quantity } from './quantity.js';

export type ReconciliationLine = {
  readonly supplierCode: string;
  readonly sku: string | null;
  readonly invoiced: Quantity;
  readonly counted: Quantity;
  readonly missing: Quantity;
};

/**
 * 2ª entrega — conciliação da contagem: cruza o faturado na nota com o contado no recebimento,
 * linha a linha, já convertido para UN pelo fator do produto (regra 4).
 * Dona: planos #69 (E1) e #73 (E3).
 *
 * Preencha aqui; não mude o nome nem a assinatura.
 */
export function reconcile(
  _invoice: Invoice,
  _receipt: Receipt,
  _products: readonly Product[],
): readonly ReconciliationLine[] {
  return [];
}
