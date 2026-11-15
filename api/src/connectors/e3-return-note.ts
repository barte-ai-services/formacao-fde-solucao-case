// #45/AC-3 e AC-4: liquida a proposta aprovada do E3 e publica a nota de devolução na caixa de saída do ERP.
import { settleQuantidadeMenor } from '../domain/checks/e3-quantidade-menor.js';
import type { InvoiceView, Proposal, ReconciliationLine, Title } from '../domain/index.js';
import type { Published, ReturnNoteMessage, ReturnNoteOutbox } from './ports.js';

export type SettleQuantidadeMenorInput = {
  readonly proposal: Proposal;
  readonly title: Title;
  readonly invoice: InvoiceView;
  readonly lines: readonly ReconciliationLine[];
  readonly outbox: ReturnNoteOutbox;
};

/** Reduz o título e publica a devolução. Publicar de novo a mesma nota não grava outra linha. */
export async function settleApprovedQuantidadeMenor({
  proposal,
  title,
  invoice,
  lines,
  outbox,
}: SettleQuantidadeMenorInput): Promise<Published<ReturnNoteMessage>> {
  const note: ReturnNoteMessage = settleQuantidadeMenor(proposal, title, invoice, lines);
  return outbox.publish(note);
}
