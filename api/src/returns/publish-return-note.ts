// #156 Os casos de uso da devolução decidida (#156): publicar a nota de uma decisão e varrer as decisões.
import type { Published, ReturnNoteMessage, ReturnNoteOutbox } from '../connectors/ports.js';
import { returnNoteFor, type InvoiceView, type Product, type Receipt, type ReturnDecision } from '../domain/index.js';

/** #156 Uma decisão a avaliar: a nota, a decisão com o dia, os recebimentos da nota e o cadastro. */
export type DecidedReturnCase = {
  readonly invoice: InvoiceView;
  readonly decision: ReturnDecision;
  readonly receipts: readonly Receipt[];
  readonly products: readonly Product[];
};

const byDayThenId = (a: Receipt, b: Receipt): number =>
  a.receivedOn === b.receivedOn ? a.id.localeCompare(b.id) : a.receivedOn.localeCompare(b.receivedOn);

/**
 * #156 O domínio lê um recebimento só: junta os da nota, do dia da decisão ou anteriores, num só.
 * Só entram os de mesma chave e `receivedOn <= decidedOn`; o recebimento junto fica com o dia do mais
 * antigo e todos os itens, na ordem do dia e do id, para que a mesma decisão dê sempre a mesma nota.
 */
export function mergeReceipts(invoiceAccessKey: string, decidedOn: string, receipts: readonly Receipt[]): Receipt | null {
  const [first, ...rest] = receipts
    .filter((r) => r.invoiceAccessKey === invoiceAccessKey && r.receivedOn <= decidedOn)
    .sort(byDayThenId);
  if (first === undefined) return null;
  if (rest.length === 0) return first;
  return { ...first, items: [first, ...rest].flatMap((r) => r.items) };
}

/**
 * #156 a AC-5, AC-8: publica na caixa de saída a devolução da decisão, e devolve o que publicou;
 * decisão que não devolve não grava nada e dá `null`. A idempotência é da caixa de saída.
 */
export async function publishReturnNote(
  decided: DecidedReturnCase,
  outbox: ReturnNoteOutbox,
): Promise<Published<ReturnNoteMessage> | null> {
  const { invoice, decision, receipts, products } = decided;
  const receipt = mergeReceipts(invoice.accessKey, decision.decidedOn, receipts);
  const note = returnNoteFor(invoice, decision, receipt, products);
  return note === null ? null : outbox.publish(note);
}
