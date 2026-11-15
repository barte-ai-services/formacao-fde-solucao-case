import type { CheckContext, PostedInvoice, PurchaseOrder, PurchaseOrderItem } from '../context.js';
import { Divergence } from '../divergence.js';
import { DomainError } from '../errors.js';
import type { Evidence } from '../evidence.js';
import type { InvoiceItem, InvoiceView } from '../invoice.js';
import type { Title } from '../title.js';
import type { Check } from './check.js';

/** Os dois motivos de uma duplicidade, lidos da fonte da evidência. */
export type DuplicateReason = 'titulo_lancado' | 'ordem_sem_saldo'; // ADR-002

/**
 * E6 — duplicidade: a mesma nota, ou uma ordem sem saldo, cobrada de novo.
 * Regra que rege: regras 1, 3 e 5 (roda primeiro; achando algo, a conferência para — regra 2).
 * Dona: plano #62 (história #31).
 *
 * Devolve zero ou uma divergência E6: título já lançado ou, sem ele, ordem sem saldo.
 */
export const checkDuplicidade: Check = (invoice, ctx) => {
  const posted = postedDuplicate(invoice, ctx.postedInvoices);
  // regra 5, #31/AC-3: o saldo que Compras publica já desconta o título achado; checar o saldo
  // repetiria o mesmo fato. Título lançado dispensa a checagem de saldo: uma E6 por nota.
  if (posted) return [posted];
  const noBalance = orderWithoutBalance(invoice, ctx);
  return noBalance ? [noBalance] : [];
}; // ADR-002

/** Qual dos dois motivos sustenta a divergência E6. */
export function duplicateReason(d: Divergence): DuplicateReason {
  return d.evidence.some((e) => e.source === 'erp_contas_a_pagar') ? 'titulo_lancado' : 'ordem_sem_saldo';
}

/**
 * Contas a pagar, reagindo à duplicidade detectada. Regra 3, #31/AC-5: bloqueia o título da nota
 * duplicada, e só ele, que assim fica fora da lista do dia. Título de outra chave não é tocado.
 * A proposta da E6 (recusar, bloqueio, valor em risco = total) é do `proposeChecked` do #63.
 */
export function blockDuplicateTitle(invoice: Pick<InvoiceView, 'accessKey' | 'classification'>, title: Title): void {
  if (invoice.classification !== 'E6') {
    throw new DomainError(`Duplicidade: a nota ${invoice.accessKey} está ${invoice.classification}, não E6`);
  }
  if (title.invoiceAccessKey !== invoice.accessKey) {
    throw new DomainError(`Duplicidade: o título ${title.invoiceAccessKey} não é da nota ${invoice.accessKey}`);
  }
  title.block();
}

// regra 3, #31/AC-2: a nota cobra a mesma ordem e o mesmo valor de um título já lançado (reemissão);
// regra 1, #142: a mesma chave de um título já lançado ou pago é a mesma nota chegando de novo (reenvio).
function postedDuplicate(invoice: InvoiceView, postedInvoices: readonly PostedInvoice[]): Divergence | null {
  const ref = invoice.purchaseOrderRef;
  const resent = postedInvoices.filter((p) => p.accessKey === invoice.accessKey);
  const reissued =
    ref === null
      ? []
      : postedInvoices.filter((p) => p.accessKey !== invoice.accessKey && p.purchaseOrderRef === ref && p.total.equals(invoice.total));
  const matches = [...resent, ...reissued];
  if (matches.length === 0) return null;
  const evidence: Evidence[] = matches.map((p) => ({
    source: 'erp_contas_a_pagar',
    reference: p.accessKey,
    description: `Título já lançado da nota ${p.number}, ordem ${p.purchaseOrderRef ?? 'sem-ordem'}, ${p.total.toString()}, situação ${p.status}`,
  }));
  evidence.push({
    source: 'sefaz',
    reference: invoice.accessKey,
    description:
      resent.length > 0
        ? `Nota ${invoice.number} cobra de novo a mesma chave de acesso, reenvio pelo canal ${invoice.entryChannel}`
        : `Nota ${invoice.number} cobra a mesma ordem e o mesmo valor`,
  });
  // regra 6, #31/AC-2: Divergence.of exige ao menos uma evidência.
  return Divergence.of({ classification: 'E6', skus: skusOf(invoice.items), evidence });
}

// regra 5, #31/AC-3: cobrar um item de ordem sem saldo é duplicidade suspeita; saldo parcial, não.
function orderWithoutBalance(invoice: InvoiceView, ctx: CheckContext): Divergence | null {
  const ref = invoice.purchaseOrderRef;
  if (ref === null) return null;
  const order = ctx.purchaseOrders.find((o) => o.id === ref);
  if (!order) return null; // sem ordem é E5, de outro plano
  const charged = invoice.items.filter((i) => {
    const orderItem = orderItemFor(order, i);
    // Só o número: Compras publica o saldo e ele nunca fica negativo (regra 5).
    return orderItem !== undefined && orderItem.balance.amount <= 0;
  });
  if (charged.length === 0) return null;
  const what = charged.map((i) => `${i.description} (${i.supplierCode})`).join(', ');
  return Divergence.of({
    classification: 'E6',
    skus: skusOf(charged),
    evidence: [
      {
        source: 'erp_compras',
        reference: order.id,
        description: `Duplicidade suspeita: a ordem ${order.id} não tem saldo para ${what}`,
      },
    ],
  });
}

function orderItemFor(order: PurchaseOrder, item: InvoiceItem): PurchaseOrderItem | undefined {
  return (
    order.items.find((o) => o.supplierCode === item.supplierCode) ??
    order.items.find((o) => o.sku !== null && item.sku !== null && o.sku === item.sku)
  );
}

function skusOf(items: readonly InvoiceItem[]): string[] {
  return items.flatMap((i) => (i.sku === null ? [] : [i.sku]));
}
