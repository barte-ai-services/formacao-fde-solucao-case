import { AmountAtRisk } from './amount-at-risk.js';
import type { ApprovalLevel } from './approval-level.js';
import type { Classification } from './classification.js';
import type { CheckContext, Product, PurchaseOrder, Receipt, Supplier } from './context.js';
import { matchByDescription } from './description-match.js';
import { DomainError } from './errors.js';
import type { InvoiceItem, InvoiceView } from './invoice.js';
import { Money } from './money.js';
import { Quantity } from './quantity.js';
import type { Title } from './title.js';

export type ReconciliationLine = {
  readonly supplierCode: string;
  readonly sku: string | null;
  readonly invoiced: Quantity;
  readonly counted: Quantity;
  readonly missing: Quantity;
};

/** Regra 4, #69: acha o produto do item, pelo SKU ou pelo código do fornecedor. */
function productOf(
  supplierId: string,
  item: { readonly supplierCode: string; readonly sku?: string | null },
  products: readonly Product[],
): Product | undefined {
  return (
    products.find((p) => item.sku != null && p.sku === item.sku) ??
    products.find((p) => p.supplierId === supplierId && p.supplierCode === item.supplierCode)
  );
}

/** Regra 4, #69: em UN pelo fator do produto; sem produto, fica na unidade em que veio. */
function inUnits(q: Quantity, product: Product | undefined): Quantity {
  return product ? q.toUnits(product.boxFactor) : q;
}

/**
 * 2ª entrega — conciliação da contagem: cruza o faturado na nota com o contado no recebimento,
 * linha a linha, já convertido para UN pelo fator do produto (regra 4).
 * Dona: planos #69 (E1) e #73 (E3).
 *
 * #69/AC-1: só concilia o recebimento ligado à nota pela chave de acesso; outro devolve [].
 * Uma linha por item da nota, na ordem da nota. O item que não aparece na contagem fica com contado
 * zero. O item que não dá para pôr na mesma unidade (sem produto e unidades diferentes) fica de fora:
 * é caso do E8 ou do E4, não da contagem.
 */
export function reconcile(
  invoice: InvoiceView,
  receipt: Receipt,
  products: readonly Product[],
): readonly ReconciliationLine[] {
  if (receipt.invoiceAccessKey === null || receipt.invoiceAccessKey !== invoice.accessKey) return [];

  // #69: o que ainda sobra de cada item contado, já na unidade da linha. A nota pode repetir o
  // #69: código do fornecedor; cada linha leva só o que cobra, e a última com o código leva o resto.
  const remaining = new Map<number, Quantity>();
  const available = (i: number) => remaining.get(i)?.amount !== 0;
  const candidates = (item: InvoiceItem): number[] => {
    const byCode = receipt.items.flatMap((r, i) => (r.supplierCode === item.supplierCode && available(i) ? [i] : []));
    if (byCode.length > 0) return byCode;
    const open = receipt.items.flatMap((_, i) => (available(i) && !remaining.has(i) ? [i] : []));
    const found = matchByDescription(item.description, open.map((i) => receipt.items[i]?.description ?? ''));
    const index = found === null ? undefined : open[found];
    return index === undefined ? [] : [index];
  };

  const lines: ReconciliationLine[] = [];
  invoice.items.forEach((item, position) => {
    const product = productOf(invoice.supplierId, item, products);
    const invoiced = inUnits(item.quantity, product);
    const lastWithCode = !invoice.items.slice(position + 1).some((i) => i.supplierCode === item.supplierCode);
    const matched = candidates(item);
    const pool: { index: number; left: Quantity }[] = [];
    for (const index of matched) {
      const counter = receipt.items[index];
      if (!counter) continue;
      const left = remaining.get(index) ?? inUnits(counter.quantity, product);
      if (left.unit !== invoiced.unit) return;
      pool.push({ index, left });
    }
    let counted = Quantity.of(0, invoiced.unit);
    for (const { index, left } of pool) {
      const need = invoiced.subtract(counted);
      const take = lastWithCode ? left : left.isLessThan(need) ? left : need;
      counted = Quantity.of(counted.amount + take.amount, counted.unit);
      remaining.set(index, left.subtract(take));
    }
    const missing = invoiced.isLessThan(counted) ? Quantity.of(0, invoiced.unit) : invoiced.subtract(counted);
    lines.push(Object.freeze({ supplierCode: item.supplierCode, sku: item.sku, invoiced, counted, missing }));
  });
  return Object.freeze(lines);
}

/** #69/AC-1: o recebimento da nota, pela chave de acesso. O recebimento sem chave nunca casa. */
export function findReceipt(invoice: InvoiceView, receipts: readonly Receipt[]): Receipt | null {
  return receipts.find((r) => r.invoiceAccessKey !== null && r.invoiceAccessKey === invoice.accessKey) ?? null;
}

export type UnreconciledReceipt = {
  readonly receipt: Receipt;
  readonly reason: 'no_key' | 'key_without_invoice';
};

/** #69/AC-1: o recebimento que não concilia com nenhuma nota, e por quê, para ficar registrado. */
export function unreconciledReceipts(
  receipts: readonly Receipt[],
  invoices: readonly InvoiceView[],
): readonly UnreconciledReceipt[] {
  const keys = new Set(invoices.map((i) => i.accessKey));
  const out: UnreconciledReceipt[] = [];
  for (const receipt of receipts) {
    if (receipt.invoiceAccessKey === null) out.push({ receipt, reason: 'no_key' });
    else if (!keys.has(receipt.invoiceAccessKey)) out.push({ receipt, reason: 'key_without_invoice' });
  }
  return Object.freeze(out);
}

/** #69: o item da nota que não aparece na contagem (E1). Chegar a menos é E3, do #73. */
export function isMissingLine(line: ReconciliationLine): boolean {
  return line.counted.amount === 0 && line.invoiced.amount > 0;
}

/** #69: os itens da nota que não aparecem na contagem, com a linha da conciliação. */
export function missingItems(
  invoice: InvoiceView,
  lines: readonly ReconciliationLine[],
): readonly { readonly item: InvoiceItem; readonly line: ReconciliationLine }[] {
  // #69: as linhas seguem a ordem da nota; cada item casa com uma linha só, mesmo com código repetido.
  const out: { item: InvoiceItem; line: ReconciliationLine }[] = [];
  let next = 0;
  for (const line of lines) {
    const at = invoice.items.findIndex(
      (i, idx) => idx >= next && i.supplierCode === line.supplierCode && i.sku === line.sku,
    );
    const item = invoice.items[at];
    if (!item) continue;
    next = at + 1;
    if (isMissingLine(line)) out.push({ item, line });
  }
  return out;
}

/** #69/AC-4, regra 6: o valor em risco do E1 é o valor dos itens que faltam, entre zero e a nota. */
export function amountAtRiskOfMissing(invoice: InvoiceView, lines: readonly ReconciliationLine[]): AmountAtRisk {
  const sum = missingItems(invoice, lines).reduce((acc, { item }) => acc.add(item.total), Money.zero());
  return AmountAtRisk.of(sum, invoice.total);
}

/** #69/AC-3: a ordem que a nota cobra, pelo número. */
export function orderOf(invoice: InvoiceView, orders: readonly PurchaseOrder[]): PurchaseOrder | null {
  return invoice.purchaseOrderRef === null ? null : (orders.find((o) => o.id === invoice.purchaseOrderRef) ?? null);
}

export type CountAssessment =
  | { readonly status: 'no_count' }
  | {
      readonly status: 'matches' | 'mismatch';
      readonly receipt: Receipt;
      readonly lines: readonly ReconciliationLine[];
    };

/**
 * #69/AC-3 e AC-7, gateway "A contagem bate?": contagem, nota e pedido na mesma unidade (UN).
 * Bate quando todo item da nota foi contado inteiro e cabe no saldo do pedido (regra 5).
 * Sem recebimento ligado pela chave, a nota espera a contagem.
 */
export function assessCount(invoice: InvoiceView, ctx: CheckContext): CountAssessment {
  const receipt = findReceipt(invoice, ctx.receipts);
  if (receipt === null) return { status: 'no_count' };
  const lines = reconcile(invoice, receipt, ctx.products);
  const order = orderOf(invoice, ctx.purchaseOrders);

  const countOk = lines.length === invoice.items.length && lines.every((l) => l.missing.amount === 0);
  const orderOk =
    order !== null &&
    lines.every((line) => {
      const orderItem = order.items.find(
        (o) => o.supplierCode === line.supplierCode || (line.sku !== null && o.sku === line.sku),
      );
      if (!orderItem) return false;
      const product = productOf(order.supplierId, orderItem, ctx.products);
      const balance = inUnits(orderItem.balance, product);
      return balance.unit === line.invoiced.unit && !balance.isLessThan(line.invoiced);
    });

  return { status: countOk && orderOk ? 'matches' : 'mismatch', receipt, lines };
}

const DIRECTORS_FROM = Money.ofCents(10_000_000);
const COORDINATION_FROM = Money.ofCents(2_000_000);
const COORDINATION_CODES: readonly Classification[] = ['E5', 'E7', 'E8', 'NAO_CATALOGADA'];
const COUNT_CODES: readonly Classification[] = ['E1', 'E2', 'E3', 'E4'];

/**
 * #69/AC-6 e AC-7: o encaminhamento da nota depois da contagem, pelos limites de aprovação, na ordem
 * das 6 linhas; vale a primeira que se aplica. A contagem que não bate conta como E1 a E4.
 * 1. E6: bloqueio. 2. Nota acima de R$ 100 mil, ou fornecedor com pagamento bloqueado: diretoria.
 * 3. E5, E7, E8 ou não catalogada: coordenação. 4. E1 a E4, nota acima de R$ 20 mil: coordenação.
 * 5. E1 a E4, nota de até R$ 20 mil: analista. 6. O resto (a contagem bate): regra, sem pessoa.
 * #69: cópia provisória; quando a ApprovalPolicy da #63 entrar na main, ela substitui esta função.
 */
export function countRoute(
  invoice: InvoiceView,
  assessment: CountAssessment,
  suppliers: readonly Supplier[] = [],
): ApprovalLevel {
  if (assessment.status === 'no_count') {
    throw new DomainError('Conciliação: sem contagem, a nota espera a contagem antes de ser encaminhada');
  }
  const found = invoice.divergences.map((d) => d.classification);
  const has = (codes: readonly Classification[]) => found.some((c) => codes.includes(c));
  const blocked = suppliers.some((s) => s.id === invoice.supplierId && s.paymentBlocked);

  if (found.includes('E6')) return 'bloqueio';
  if (invoice.total.compare(DIRECTORS_FROM) > 0 || blocked) return 'diretoria';
  if (has(COORDINATION_CODES)) return 'coordenacao';
  if (assessment.status === 'mismatch' || has(COUNT_CODES)) {
    return invoice.total.compare(COORDINATION_FROM) > 0 ? 'coordenacao' : 'analista';
  }
  return 'regra';
}

/** #69/AC-5: o título só vai à lista do dia depois da contagem da sua nota conciliada. */
export function scheduleAfterCount(title: Title, assessment: CountAssessment): void {
  if (assessment.status === 'no_count') {
    throw new DomainError('Title: só vai à lista do dia depois da contagem conciliada');
  }
  if (assessment.receipt.invoiceAccessKey !== title.invoiceAccessKey) {
    throw new DomainError('Title: a contagem conciliada é de outra nota');
  }
  title.scheduleToday();
}
