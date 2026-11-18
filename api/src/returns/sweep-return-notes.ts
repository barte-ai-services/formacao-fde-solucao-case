// #7 A varredura idempotente das decisões que devolvem (#1/AC-6, AC-7).
import type { ReturnNoteOutbox } from '../connectors/ports.js';
import type { DecidedReturnSource } from './decided-return-source.js';
import { publishReturnNote } from './publish-return-note.js';

export type SweepResult = { readonly published: number; readonly alreadyQueued: number; readonly withoutReturn: number };

/**
 * #1/AC-6 e AC-7: publica a devolução de toda decisão que devolve e ainda não tem linha na fila. Quem já
 * tem qualquer linha (pendente, emitida ou cancelada) fica de fora, então com tudo na fila não grava nada.
 * Chamadas constantes por rodada (o Cron tem poucas subrequisições): uma leitura da fonte, uma listagem
 * da fila e uma publicação por nota nova.
 * #9/AC-2 `limit` (opcional) é o teto de publicações da chamada, para caber nas subrequisições do Cron: ao
 * publicar o teto, a varredura para; só conta o que publica, e a rodada seguinte segue do que faltou.
 */
export async function sweepReturnNotes(
  source: DecidedReturnSource,
  outbox: ReturnNoteOutbox,
  limit: number = Number.POSITIVE_INFINITY,
): Promise<SweepResult> {
  const decided = await source.listDecided();
  const seen = new Set((await outbox.list()).map((row) => row.invoiceAccessKey));
  let published = 0;
  let alreadyQueued = 0;
  let withoutReturn = 0;
  for (const one of decided) {
    if (published >= limit) break;
    if (seen.has(one.invoice.accessKey)) {
      alreadyQueued += 1;
    } else if ((await publishReturnNote(one, outbox)) === null) {
      withoutReturn += 1;
    } else {
      seen.add(one.invoice.accessKey);
      published += 1;
    }
  }
  return { published, alreadyQueued, withoutReturn };
}
