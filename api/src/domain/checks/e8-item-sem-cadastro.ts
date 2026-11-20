import { AmountAtRisk } from '../amount-at-risk.js';
import type { CheckContext, Product } from '../context.js';
import { matchByDescription, type DescriptionMatchRequest } from '../description-match.js';
import { Divergence } from '../divergence.js';
import type { Evidence } from '../evidence.js';
import type { InvoiceItem, InvoiceView } from '../invoice.js';
import { Money } from '../money.js';
import { orderOf } from '../reconciliation.js';
import type { Check } from './check.js';

function supplierProducts(invoice: InvoiceView, ctx: CheckContext): readonly Product[] {
  return ctx.products.filter((p) => p.supplierId === invoice.supplierId);
}

/** #35 O item está no cadastro do fornecedor pelo SKU ou pelo código do fornecedor, sem olhar a descrição. */
function registeredByKey(item: InvoiceItem, products: readonly Product[]): boolean {
  return products.some((p) => (item.sku !== null && p.sku === item.sku) || p.supplierCode === item.supplierCode);
}

/**
 * #35 Os pedidos de casamento por descrição que a conferência desta nota vai fazer: um por item sem
 * SKU que nem o código do fornecedor acha. Os candidatos saem na mesma ordem que a verificação usa,
 * para que a sugestão do Claude guardada na rodada seja a que a verificação lê.
 */
export function descriptionMatchRequests(invoice: InvoiceView, ctx: CheckContext): DescriptionMatchRequest[] {
  const products = supplierProducts(invoice, ctx);
  const candidates = products.map((p) => p.description);
  if (candidates.length === 0) return [];
  return invoice.items
    .filter((item) => item.sku === null && !registeredByKey(item, products))
    .map((item) => ({ description: item.description, candidates }));
}

/**
 * #35, AC-1 e AC-2: os itens da nota que não estão no cadastro do fornecedor: nem pelo SKU, nem pelo código do
 * fornecedor, nem (quando o SKU vem vazio) pela descrição.
 */
export function unregisteredItems(invoice: InvoiceView, ctx: CheckContext): readonly InvoiceItem[] {
  const products = supplierProducts(invoice, ctx);
  const candidates = products.map((p) => p.description);
  return invoice.items.filter((item) => {
    if (registeredByKey(item, products)) return false;
    return item.sku !== null || matchByDescription(item.description, candidates) === null;
  });
}

/** #338 A referência da evidência de uma divergência E8: o fornecedor e o código do item, a chave que a leitura das divergências guardadas usa para achar o item. */
export const e8Reference = (invoice: InvoiceView, item: InvoiceItem): string => `${invoice.supplierId}/${item.supplierCode}`;

/**
 * #338 Os itens que a verificação E8 desta nota achou sem cadastro, lidos das divergências E8 guardadas (uma por item: `skus` com o SKU do item, ou vazio sem SKU,
 * e a primeira evidência com a referência de e8Reference). Não refaz a conferência: ela correu com as sugestões de descrição da rodada (capture.ts, withDescriptionMatches),
 * que não ficam guardadas, e reler o cadastro sem elas poderia incluir um item que a regra casou por descrição.
 */
export function storedUnregisteredItems(invoice: InvoiceView): readonly InvoiceItem[] {
  const stored = invoice.divergences.filter((d) => d.classification === 'E8');
  return invoice.items.filter((item) =>
    stored.some(
      (d) =>
        d.evidence[0]?.reference === e8Reference(invoice, item) &&
        (item.sku === null ? d.skus.length === 0 : d.skus.length === 1 && d.skus[0] === item.sku),
    ),
  );
}

/** Regra 6 e #35, AC-3: o valor em risco do E8 é a soma dos itens sem cadastro. */
export function amountAtRiskOfUnregistered(invoice: InvoiceView, ctx: CheckContext): AmountAtRisk {
  const sum = unregisteredItems(invoice, ctx).reduce((acc, item) => acc.add(item.total), Money.zero());
  return AmountAtRisk.of(sum, invoice.total);
}

/**
 * E8 — item sem cadastro de produto.
 * Regra que rege: regra 6.
 * Dona: plano #66 (história #35).
 *
 * Preencha aqui; não mude o nome nem a assinatura.
 */
export const checkItemSemCadastro: Check = (invoice, ctx) => {
  // #66 A ordem travada que a nota cita entra como segunda evidência de cada E8 (a tela mostra "Ordem: travada").
  const order = orderOf(invoice, ctx.purchaseOrders);
  const lockedOrder: Evidence[] =
    order !== null && order.status === 'travada'
      ? [{ source: 'erp_compras', reference: order.id, description: `Ordem ${order.id} travada: ${order.statusReason}` }]
      : [];
  return unregisteredItems(invoice, ctx).map((item) =>
    Divergence.of({
      classification: 'E8',
      skus: item.sku ? [item.sku] : [],
      evidence: [
        {
          source: 'erp_cadastro',
          reference: e8Reference(invoice, item),
          description:
            `O item "${item.description}" (código do fornecedor ${item.supplierCode}, ` +
            `${item.sku ? `SKU ${item.sku}` : 'SKU vazio'}, valor ${item.total.toString()}) não está no ` +
            `cadastro do fornecedor ${invoice.supplierId}: não casa por SKU, por código do fornecedor nem por descrição.`,
        },
        ...lockedOrder,
      ],
    }),
  );
};
