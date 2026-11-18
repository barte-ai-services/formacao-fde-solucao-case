import type { ReturnNote } from './checks/e3-quantidade-menor.js';
import type { Classification } from './classification.js';
import type { Product, Receipt } from './context.js';
import type { PartialLine } from './dock-action.js';
import type { InvoiceItem, InvoiceView } from './invoice.js';
import type { Proposal } from './proposal.js';
import { Quantity, type Unit } from './quantity.js';

export type { ReturnNote };

/** #156: o que a devolução lê da proposta decidida, mais o dia da decisão (YYYY-MM-DD). */
export type ReturnDecision = Pick<Proposal, 'classification' | 'state' | 'dockAction'> & {
  readonly decidedOn: string;
};

/** #156: a chave da linha da doca é o SKU do item, ou o código do fornecedor sem SKU (draft-checked `keyOf`). */
const keyOf = (item: InvoiceItem): string => item.sku ?? item.supplierCode;

/** #156: classificações cuja decisão nunca devolve (E6 é cancelamento, fora do escopo). */
const WITHOUT_RETURN: readonly Classification[] = ['MATCH', 'E4', 'E5', 'E6', 'E7', 'E8'];

/** #156: a nota de devolução da proposta de E3 que já saía pelo `e3ReturnNote`; o texto não muda. */
const reasonOf = (classification: Classification, invoice: InvoiceView, kind: 'partial' | 'refusal'): string => {
  if (kind === 'refusal') {
    return `${classification} recusada na nota ${invoice.number}: devolução dos itens já recebidos`;
  }
  if (classification === 'E1') {
    return `E1 falta física na nota ${invoice.number}: devolução simbólica dos itens ausentes da contagem`;
  }
  if (classification === 'E2') return `E2 item trocado na nota ${invoice.number}: devolução do item trocado`;
  return `E3 quantidade menor na nota ${invoice.number}: devolução da diferença`;
};

/** #156 a AC-3: as linhas da ação que voltam: E3 só as `devolver`; E1 e E2 todas as da ação. */
function partialLines(decision: ReturnDecision): readonly PartialLine[] {
  const action = decision.dockAction;
  if (action.kind !== 'receber_parcial') return [];
  if (decision.classification === 'E3') return action.lines.filter((l) => l.disposition === 'devolver');
  if (decision.classification === 'E1' || decision.classification === 'E2') return action.lines;
  return [];
}

function fromPartial(invoice: InvoiceView, decision: ReturnDecision, products: readonly Product[]): ReturnNote | null {
  const lines = partialLines(decision).flatMap((line) => {
    const item = invoice.items.find((i) => keyOf(i) === line.sku);
    if (item === undefined) return [];
    // #156: a linha sai sempre na unidade do item da nota, pelo mesmo caminho da recusa.
    // #156: linha em outra unidade sem fator de caixa é pulada de propósito, como lá (não há como convertê-la).
    const amount = inItemUnit(line.quantity, item.quantity.unit, boxFactorOf(invoice, item, products));
    return amount === null ? [] : [{ supplierCode: item.supplierCode, quantity: Quantity.of(amount, item.quantity.unit) }];
  });
  if (lines.length === 0) return null;
  return { invoiceAccessKey: invoice.accessKey, lines, reason: reasonOf(decision.classification, invoice, 'partial') };
}

function boxFactorOf(invoice: InvoiceView, item: InvoiceItem, products: readonly Product[]): number {
  const product =
    products.find((p) => item.sku !== null && p.sku === item.sku) ??
    products.find((p) => p.supplierId === invoice.supplierId && p.supplierCode === item.supplierCode);
  return product?.boxFactor ?? 0;
}

/**
 * #156 e AC-4: a quantidade (recebida ou da linha da ação) na unidade do item da nota. A conversão é proporcional e exata, sem arredondar:
 * 7 UN com fator 6 em item de CX dá 7/6 CX, porque a fila de #140 valora a linha por quantidade x
 * preço unitário da nota, e assim o valor devolvido fecha. Linha recebida sem fator de caixa (ausente
 * ou inválido) é pulada de propósito: não há como convertê-la para a unidade da nota.
 */
function inItemUnit(quantity: Quantity, unit: Unit, factor: number): number | null {
  if (quantity.unit === unit) return quantity.amount;
  if (!Number.isSafeInteger(factor) || factor <= 0) return null;
  return unit === 'UN' ? quantity.amount * factor : quantity.amount / factor;
}

/**
 * #156: o que entrou do código do fornecedor, na unidade do primeiro item da nota com o código.
 * Soma o recebido por unidade e converte cada total uma vez, para não acumular erro de ponto
 * flutuante (seis linhas de 1 UN, fator 6, dão 1 CX exato).
 */
function receivedOf(invoice: InvoiceView, item: InvoiceItem, receipt: Receipt, products: readonly Product[]): number {
  const factor = boxFactorOf(invoice, item, products);
  const totals = new Map<Unit, number>();
  for (const r of receipt.items.filter((i) => i.supplierCode === item.supplierCode)) {
    totals.set(r.quantity.unit, (totals.get(r.quantity.unit) ?? 0) + r.quantity.amount);
  }
  let received = 0;
  for (const [unit, amount] of totals) {
    received += inItemUnit(Quantity.of(amount, unit), item.quantity.unit, factor) ?? 0;
  }
  return received;
}

function fromRefusal(
  invoice: InvoiceView,
  decision: ReturnDecision,
  receipt: Receipt | null,
  products: readonly Product[],
): ReturnNote | null {
  if (receipt === null || receipt.invoiceAccessKey !== invoice.accessKey) return null;
  if (receipt.receivedOn > decision.decidedOn) return null;
  const lines = invoice.items.flatMap((item, position) => {
    const isFirstWithCode = invoice.items.findIndex((i) => i.supplierCode === item.supplierCode) === position;
    if (!isFirstWithCode) return [];
    const invoiced = invoice.items
      .filter((i) => i.supplierCode === item.supplierCode && i.quantity.unit === item.quantity.unit)
      .reduce((sum, i) => sum + i.quantity.amount, 0);
    const amount = Math.min(receivedOf(invoice, item, receipt, products), invoiced);
    return amount > 0 ? [{ supplierCode: item.supplierCode, quantity: Quantity.of(amount, item.quantity.unit) }] : [];
  });
  if (lines.length === 0) return null;
  return { invoiceAccessKey: invoice.accessKey, lines, reason: reasonOf(decision.classification, invoice, 'refusal') };
}

/**
 * #156 a AC-8: a nota de devolução de uma proposta decidida (`aprovada` ou `alterada`, pela ação
 * atual), ou `null` quando a decisão não devolve. Generaliza o `e3ReturnNote` para E1, E2, E3 em
 * receber parcial e para a recusa com mercadoria já entrada (recebimento da nota, do dia da decisão
 * ou anterior). Linhas e quantidades saem da nota de origem, na ordem da ação ou da nota; a mesma
 * decisão dá sempre a mesma nota, para a caixa de saída idempotente.
 */
export function returnNoteFor(
  invoice: InvoiceView,
  decision: ReturnDecision,
  receipt: Receipt | null,
  products: readonly Product[],
): ReturnNote | null {
  if (decision.state !== 'aprovada' && decision.state !== 'alterada') return null;
  if (WITHOUT_RETURN.includes(decision.classification)) return null;
  const action = decision.dockAction;
  if (action.kind === 'receber_parcial') return fromPartial(invoice, decision, products);
  if (action.kind === 'recusar') return fromRefusal(invoice, decision, receipt, products);
  return null;
}
