// #45/AC-3 e AC-4: liquida a proposta aprovada do E3 e publica a nota de devolução na caixa de saída do ERP.
import { e3ReturnNote, reduceE3Title } from '../domain/checks/e3-quantidade-menor.js';
import type { InvoiceView, Proposal, ReconciliationLine, Title } from '../domain/index.js';
import type { Published, ReturnNoteMessage, ReturnNoteOutbox } from './ports.js';

export type SettleE3ShortfallInput = {
  readonly proposal: Proposal;
  readonly title: Title;
  readonly invoice: InvoiceView;
  readonly lines: readonly ReconciliationLine[];
  readonly outbox: ReturnNoteOutbox;
};

/**
 * #73: publica a devolução antes de reduzir o título. Se publicar falha, o título fica como estava e
 * a nova tentativa passa; publicar de novo a mesma nota não grava outra linha (#59).
 */
export async function settleApprovedE3Shortfall({
  proposal,
  title,
  invoice,
  lines,
  outbox,
}: SettleE3ShortfallInput): Promise<Published<ReturnNoteMessage>> {
  const note: ReturnNoteMessage = e3ReturnNote(proposal, title, invoice, lines);
  const published = await outbox.publish(note);
  reduceE3Title(proposal, title);
  return published;
}
