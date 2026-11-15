import { AmountAtRisk } from '../amount-at-risk.js';
import { routeDivergences } from '../approval-policy.js';
import type { ApprovalLevel } from '../approval-level.js';
import type { CheckContext, Product, PurchaseOrder, PurchaseOrderItem } from '../context.js';
import { matchByDescription } from '../description-match.js';
import { Divergence } from '../divergence.js';
import type { InvoiceItem, InvoiceView } from '../invoice.js';
import { Money } from '../money.js';
import type { Check } from './check.js';

/** Um item da nota que veio no lugar de um item da ordem que não veio. */
type Swap = {
  readonly item: InvoiceItem;
  readonly product: Product;
  readonly missing: PurchaseOrderItem;
};

type Swaps = { readonly order: PurchaseOrder; readonly swaps: readonly Swap[] };

const sameSku = (a: string | null, b: string | null): boolean => a !== null && b !== null && a === b;

const matchesByCode = (item: InvoiceItem, poItem: PurchaseOrderItem): boolean =>
  poItem.supplierCode === item.supplierCode || sameSku(poItem.sku, item.sku);

/**
 * Casa os itens da nota com os itens da ordem; cada item da ordem casa uma vez só.
 * Primeiro pelo código do fornecedor ou pelo SKU, em todos os itens; depois pela descrição, só nos
 * que sobraram contra os itens da ordem ainda livres, para a descrição não roubar quem casa pelo código.
 * Devolve, por item da nota, se ele está na ordem, e quais itens da ordem ficaram livres.
 */
function matchAgainstOrder(
  items: readonly InvoiceItem[],
  orderItems: readonly PurchaseOrderItem[],
): { readonly onOrder: readonly boolean[]; readonly unclaimed: readonly PurchaseOrderItem[] } {
  const claimed = orderItems.map(() => false);
  const onOrder = items.map(() => false);

  items.forEach((item, i) => {
    const j = orderItems.findIndex((po, k) => !claimed[k] && matchesByCode(item, po));
    if (j >= 0) {
      claimed[j] = true;
      onOrder[i] = true;
    }
  });

  items.forEach((item, i) => {
    if (onOrder[i]) return;
    const free = orderItems.flatMap((po, k) => (claimed[k] ? [] : [{ k, description: po.description }]));
    if (free.length === 0) return;
    const hit = matchByDescription(
      item.description,
      free.map((f) => f.description),
    );
    const j = hit === null ? undefined : free[hit]?.k;
    if (j !== undefined) {
      claimed[j] = true;
      onOrder[i] = true;
    }
  });

  return { onOrder, unclaimed: orderItems.filter((_, k) => !claimed[k]) };
}

/** O produto do fornecedor da nota no ERP Cadastro, pelo código do fornecedor ou pelo SKU. */
function registeredProduct(item: InvoiceItem, supplierId: string, products: readonly Product[]): Product | undefined {
  return products.find(
    (p) => p.supplierId === supplierId && (p.supplierCode === item.supplierCode || sameSku(p.sku, item.sku)),
  );
}

/**
 * Regra 6: item cadastrado que não está na ordem, no lugar de um que está. Os itens fora da ordem e
 * os itens da ordem que não vieram formam pares 1 a 1, na ordem da nota e na ordem da ordem.
 * Sem ordem é a E5; sem cadastro é a E8; item a mais sem nada faltando não é troca.
 */
function findSwaps(invoice: InvoiceView, ctx: CheckContext): Swaps | null {
  if (invoice.purchaseOrderRef === null) return null;
  const order = ctx.purchaseOrders.find((po) => po.id === invoice.purchaseOrderRef);
  if (order === undefined) return null;

  const { onOrder, unclaimed } = matchAgainstOrder(invoice.items, order.items);
  const missing = [...unclaimed];
  const swaps: Swap[] = [];
  invoice.items.forEach((item, i) => {
    if (onOrder[i]) return;
    const product = registeredProduct(item, invoice.supplierId, ctx.products);
    if (product === undefined) return;
    const replaced = missing.shift();
    if (replaced === undefined) return;
    swaps.push({ item, product, missing: replaced });
  });
  return { order, swaps };
}

/**
 * E2 — item trocado: veio outro produto no lugar do pedido.
 * Regra que rege: regra 6.
 * Dona: plano #70 (história #36).
 */
export const checkItemTrocado: Check = (invoice, ctx) => { // ADR-002
  const found = findSwaps(invoice, ctx);
  if (found === null) return [];
  const { order, swaps } = found;
  return swaps.map(({ item, product, missing }) =>
    Divergence.of({
      classification: 'E2',
      skus: [product.sku],
      evidence: [
        {
          source: 'erp_compras', // ADR-002
          reference: order.id,
          description: `Ordem ${order.id} pede ${missing.description} (${missing.supplierCode}), não ${item.description}`,
        },
        {
          source: 'erp_cadastro', // ADR-002
          reference: product.sku,
          description: `${item.supplierCode} é ${product.description} no cadastro do fornecedor ${invoice.supplierId}, fora da ordem`,
        },
        {
          // #97: o DivergenceDto não leva valor; a nota da SEFAZ diz o item que veio e quanto ele custa.
          source: 'sefaz', // ADR-002
          reference: invoice.accessKey,
          description: `Nota cobra ${item.description} (${item.supplierCode}) por ${item.total.toString()}`,
        },
      ],
    }),
  );
};

/** #36/AC-2, regra 6: o valor em risco da E2 é a soma do valor dos itens trocados. Zero sem E2. */
export function amountAtRiskItemTrocado(invoice: InvoiceView, ctx: CheckContext): AmountAtRisk { // ADR-002
  const swaps = findSwaps(invoice, ctx)?.swaps ?? [];
  const sum = swaps.reduce((acc, { item }) => acc.add(item.total), Money.zero());
  return AmountAtRisk.of(sum, invoice.total);
}

/** #36/AC-3, tabela de regras de aprovação linhas 4 e 5: até R$ 20 mil, analista; acima, coordenação. */
export function approvalLevelItemTrocado(invoice: InvoiceView): ApprovalLevel { // ADR-002
  // #110: a régua (#63) é a fonte única do encaminhamento; não há limite de valor aqui.
  return routeDivergences([{ classification: 'E2' }], invoice.total).level; // ADR-002
}
