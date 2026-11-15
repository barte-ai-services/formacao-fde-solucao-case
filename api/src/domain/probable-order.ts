import type { Draft } from './approval.js';
import type { CheckContext, PurchaseOrder, PurchaseOrderItem } from './context.js';
import { matchByDescription } from './description-match.js';
import { DockAction } from './dock-action.js';
import type { InvoiceItem, InvoiceView } from './invoice.js';
import { Quantity } from './quantity.js';

// #34: a ordem provável de uma nota sem ordem (E5). O agente sugere; quem confirma é esta regra.

export type ProbableOrder =
  | {
      readonly kind: 'confirmada'; // ADR-002
      readonly orderId: string;
      /** #65: quem achou a ordem; a regra confirmou nos dois casos. */
      readonly source: 'claude' | 'regra'; // ADR-002
      readonly reason: string;
    }
  | { readonly kind: 'nenhuma'; readonly reason: string }; // ADR-002

/** #65: a sugestão crua do Claude, gravada pelo executor da #66; ainda não confirmada pela regra. */
export type ProbableOrderSuggestion = { readonly orderId: string | null; readonly reason: string };

export type Confirmation = { readonly confirmed: true } | { readonly confirmed: false; readonly reason: string };

/** #34/AC-2: as ordens que podem ser a da nota: mesmo fornecedor, não travadas, por id. */
export function candidateOrders(invoice: InvoiceView, ctx: CheckContext): readonly PurchaseOrder[] {
  return ctx.purchaseOrders
    .filter((o) => o.supplierId === invoice.supplierId && o.status !== 'travada') // ADR-002
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function matchingItem(item: InvoiceItem, order: PurchaseOrder): PurchaseOrderItem | undefined {
  const byCode = order.items.find((d) => d.supplierCode === item.supplierCode);
  if (byCode) return byCode;
  const index = matchByDescription(
    item.description,
    order.items.map((d) => d.description),
  );
  return index === null ? undefined : order.items[index];
}

/**
 * #34/AC-2 e AC-3: a regra confirma a ordem só se o fornecedor e o destino são os mesmos, todo item da nota tem item
 * na ordem e a quantidade da nota, em unidades (regra 4), cabe no saldo que Compras publica (regra 5).
 * Ordem travada não confirma.
 */
export function confirmProbableOrder(invoice: InvoiceView, order: PurchaseOrder, ctx: CheckContext): Confirmation {
  if (order.supplierId !== invoice.supplierId) {
    return { confirmed: false, reason: `A ordem ${order.id} é de outro fornecedor` };
  }
  if (order.status === 'travada') {
    // ADR-002
    return { confirmed: false, reason: `A ordem ${order.id} está travada` };
  }
  if (order.store !== invoice.store) {
    return { confirmed: false, reason: `A ordem ${order.id} é de outro destino` };
  }
  // #34 regra 5: as unidades de todos os itens da nota que caem na mesma linha somam contra o saldo dela.
  const claimed = new Map<PurchaseOrderItem, number>();
  for (const item of invoice.items) {
    const line = matchingItem(item, order);
    if (!line) {
      return { confirmed: false, reason: `O item ${item.supplierCode} da nota não está na ordem ${order.id}` };
    }
    const factor = ctx.products.find((p) => p.supplierCode === item.supplierCode)?.boxFactor ?? 1;
    const units = (claimed.get(line) ?? 0) + item.quantity.toUnits(factor).amount;
    claimed.set(line, units);
    if (Quantity.of(units, 'UN').compare(line.balance) > 0) {
      return {
        confirmed: false,
        reason: `O item ${line.supplierCode} cobra ${units} UN e o saldo da ordem ${order.id} é ${line.balance.amount} UN`,
      };
    }
  }
  return { confirmed: true };
}

/**
 * #34/AC-2 e AC-3: o Claude sugere, quem decide é a regra. A sugestão vira 'confirmada' só se está
 * entre as candidatas e confirmProbableOrder a confirma. Sem sugestão confirmada, a regra decide
 * sozinha (decisão do Tech Lead no #65): se exatamente uma candidata confirma, é ela; senão, 'nenhuma'.
 */
export function resolveProbableOrder(
  invoice: InvoiceView,
  ctx: CheckContext,
  suggestion: ProbableOrderSuggestion | undefined,
): ProbableOrder {
  const candidates = candidateOrders(invoice, ctx);
  let refused: string | null = null;
  if (suggestion?.orderId) {
    const order = candidates.find((o) => o.id === suggestion.orderId);
    const confirmation = order ? confirmProbableOrder(invoice, order, ctx) : null;
    if (order && confirmation?.confirmed) {
      return { kind: 'confirmada', orderId: order.id, source: 'claude', reason: suggestion.reason }; // ADR-002
    }
    refused =
      confirmation && !confirmation.confirmed
        ? confirmation.reason
        : 'O Claude sugeriu uma ordem que não está entre as candidatas';
  }
  const confirmed = candidates.filter((o) => confirmProbableOrder(invoice, o, ctx).confirmed);
  if (confirmed.length === 1) {
    const order = confirmed[0]!;
    return {
      kind: 'confirmada', // ADR-002
      orderId: order.id,
      source: 'regra', // ADR-002
      reason: `Única ordem do mesmo fornecedor e destino com os itens e o saldo da nota`,
    };
  }
  if (refused) return { kind: 'nenhuma', reason: refused }; // ADR-002
  return {
    kind: 'nenhuma', // ADR-002
    reason:
      confirmed.length > 1
        ? 'Mais de uma ordem confirma; sem sugestão que desempate, a regra não escolhe'
        : 'Nenhuma ordem do mesmo fornecedor e destino cobre os itens e o saldo da nota',
  };
}

const MODEL_TEXT_MAX = 280;

/** #34 LLM-11: o texto do modelo entra numa linha só e cortado, sempre depois do rótulo. */
function modelText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= MODEL_TEXT_MAX ? oneLine : `${oneLine.slice(0, MODEL_TEXT_MAX - 1)}…`;
}

/**
 * #34/AC-2 e AC-3: o rascunho da proposta da nota sem ordem: recusar, com a nota inteira em risco. O
 * nível vem da régua (routeDivergences, #63): E5 vai à coordenação (AC-4). Só a ordem confirmada pela
 * regra aparece na justificativa.
 */
export function draftNotaSemOrdem(invoice: InvoiceView, probable: ProbableOrder): Draft {
  let justification = 'Nota sem ordem de compra. Não há ordem de compra confirmada para esta nota; a coordenação decide.';
  if (probable.kind === 'confirmada') {
    // ADR-002
    const found =
      probable.source === 'claude' // ADR-002
        ? `a regra confirmou fornecedor, destino, itens e saldo. Sugestão do Claude: ${modelText(probable.reason)}.`
        : 'a regra a achou sozinha: é a única do mesmo fornecedor e destino com os itens e o saldo da nota.';
    justification =
      `Nota sem ordem de compra. A ordem provável é ${probable.orderId}: ${found} ` +
      'A coordenação decide se a nota segue por essa ordem.';
  }
  return { dockAction: DockAction.refuse(), amountAtRisk: invoice.total, justification };
}
