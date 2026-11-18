import { arrayOf, isInteger, isString, nullable, oneOf, parseOne, shaped, type Shape } from '../connectors/guards.js';
import type { NextStep, ReplyOutcome, SupplierReading } from '../domain/index.js';

// #157: a leitura da resposta do fornecedor como a tabela supplier_reply_readings a guarda: um fato por mensagem, em log append-only.
// #157: a leitura atual do pedido é derivada daqui pela ordem das mensagens, nunca gravada por cima (supabase/persistence-supplier-reply.md).

export const READINGS_TABLE = 'supplier_reply_readings';

type Row = {
  id: number;
  message_id: number | null;
  reply_outcome: ReplyOutcome;
  fulfilled_asks: string[];
  supplier_document: string | null;
  summary: string;
  next_step: NextStep;
  injection_flag: string | null;
};

export const isReadingRow = shaped<Row>({
  id: isInteger,
  message_id: nullable(isInteger),
  reply_outcome: oneOf<ReplyOutcome>('fulfilled', 'partially_fulfilled', 'refused', 'needs_information', 'no_reply'), // ADR-002
  fulfilled_asks: arrayOf(isString),
  supplier_document: nullable(isString),
  summary: isString,
  next_step: oneOf<NextStep>('close', 'confirm_document', 'answer_supplier', 'follow_up'), // ADR-002
  injection_flag: nullable(isString),
} satisfies Shape<Row>);

/** #157: uma leitura gravada, com a mensagem de onde veio (nula na da varredura do prazo). */
export type ReadingRow = { readonly id: number; readonly messageId: number | null; readonly reading: SupplierReading };

/** #157: a linha da tabela vira a leitura do domínio; linha fora do formato é erro nomeado, nunca com os dados. */
export function readingFromRow(raw: unknown): ReadingRow {
  const row = parseOne(raw, isReadingRow, READINGS_TABLE);
  return {
    id: row.id,
    messageId: row.message_id,
    reading: Object.freeze({
      replyOutcome: row.reply_outcome,
      fulfilledAsks: Object.freeze([...row.fulfilled_asks]),
      supplierDocument: row.supplier_document,
      summary: row.summary,
      nextStep: row.next_step,
      injectionFlag: row.injection_flag,
    }),
  };
}

/** #157: só as colunas da leitura; não há coluna de proposta, título nem valor em risco (#157). */
export const readingToRow = (requestId: number, messageId: number | null, reading: SupplierReading): Record<string, unknown> => ({
  request_id: requestId,
  message_id: messageId,
  reply_outcome: reading.replyOutcome,
  fulfilled_asks: [...reading.fulfilledAsks],
  supplier_document: reading.supplierDocument,
  summary: reading.summary,
  next_step: reading.nextStep,
  injection_flag: reading.injectionFlag,
});

/**
 * #157: a leitura atual do pedido (a projeção do log): a da mensagem de maior id; a da varredura só vale quando não há
 * leitura de mensagem, então a resposta tardia vence o no_reply (#157). Não depende da ordem em que as linhas chegam.
 */
export function currentReading(rows: readonly ReadingRow[]): ReadingRow | null {
  let swept: ReadingRow | null = null;
  let newest: ReadingRow | null = null;
  for (const row of rows) {
    if (row.messageId === null) swept = row;
    else if (newest === null || (newest.messageId ?? 0) < row.messageId) newest = row;
  }
  return newest ?? swept;
}
