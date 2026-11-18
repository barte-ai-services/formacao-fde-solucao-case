import { arrayOf, isInteger, isIsoDate, isRecord, isString, isUnknown, nullable, oneOf, shaped, type Guard, type Shape } from '../connectors/guards.js';
import { SupabaseRestError } from '../connectors/supabase-rest.js';
import { confirmationOf, type DocumentConfirmation, type RequestStatus, type RequestType, type SupplierRequestText } from '../domain/index.js';
import type { FollowUpState, ReplyRequest } from './reply-ports.js';
import { currentReading, isReadingRow, readingFromRow, READINGS_TABLE } from './supabase-reply-reading.js';
import { noteFromJson } from './supabase-notes.js';

// #157: o pedido ao fornecedor (outbox_supplier_emails, #156) como a leitura da resposta o vê: a linha com as colunas follow_up_*,
// #157: o fornecedor e as leituras embutidos pelo PostgREST numa requisição só (supabase/persistence-supplier-reply.md, QR1 e QR2).

export const OUTBOX_TABLE = 'outbox_supplier_emails';

/** #157: o PostgREST ordena o recurso embutido por `<recurso>.order`; o adaptador não depende dela (currentReading escolhe), só a pede. */
export const READINGS_ORDER = { [`${READINGS_TABLE}.order`]: 'message_id.desc.nullslast' } as const;

/** #157: as colunas da cobrança, as que as gravações da cobrança e só elas podem tocar. */
export const FOLLOW_UP_COLUMNS =
  'follow_up_draft,follow_up_rejection,follow_up_claimed_at,follow_up_sent_by,follow_up_sent_at,follow_up_channel,follow_up_provider_message_id,follow_up_failure';

/** #157 QR1/QR2: o pedido, o fornecedor pela chave estrangeira do pedido e as leituras pela chave estrangeira nomeada. */
export const REQUEST_SELECT = [
  'id,invoice_access_key,request_type,recipient,subject,asks,note,due_on,status,supplier_id,history', // #157: o histórico leva as confirmações
  FOLLOW_UP_COLUMNS,
  'kit_fornecedores(razao_social)',
  `${READINGS_TABLE}!supplier_reply_readings_request_fkey(id,message_id,reply_outcome,fulfilled_asks,supplier_document,summary,next_step,injection_flag)`,
].join(',');

/** #157: o rascunho como a coluna o guarda: o texto e o novo prazo; o rascunho do Claude, de antes da #157, não tem `dueOn`. */
export type FollowUpDraftJson = SupplierRequestText & { readonly dueOn?: string };

export type FollowUpColumns = {
  follow_up_draft: FollowUpDraftJson | null;
  follow_up_rejection: string | null;
  follow_up_claimed_at: string | null;
  follow_up_sent_by: string | null;
  follow_up_sent_at: string | null;
  follow_up_channel: 'mock' | 'resend' | null;
  follow_up_provider_message_id: string | null;
  follow_up_failure: string | null;
};

const isOptionalDate: Guard<string | undefined> = (v): v is string | undefined => v === undefined || isIsoDate(v);
const isText = shaped<FollowUpDraftJson>({ subject: isString, body: isString, asks: arrayOf(isString), dueOn: isOptionalDate } satisfies Shape<FollowUpDraftJson>);

export const followUpShape: Shape<FollowUpColumns> = {
  follow_up_draft: nullable(isText),
  follow_up_rejection: nullable(isString),
  follow_up_claimed_at: nullable(isString),
  follow_up_sent_by: nullable(isString),
  follow_up_sent_at: nullable(isString),
  follow_up_channel: nullable(oneOf<'mock' | 'resend'>('mock', 'resend')), // ADR-002
  follow_up_provider_message_id: nullable(isString),
  follow_up_failure: nullable(isString),
};

export type RequestRow = FollowUpColumns & {
  id: number;
  invoice_access_key: string;
  request_type: RequestType;
  recipient: string;
  subject: string;
  asks: string[];
  note: unknown;
  due_on: string;
  status: RequestStatus;
  history: unknown[];
  kit_fornecedores: { razao_social: string } | null;
  supplier_reply_readings: unknown[];
};

const isSupplier = shaped<{ razao_social: string }>({ razao_social: isString });
const isReadings: Guard<unknown[]> = (v): v is unknown[] => Array.isArray(v) && v.every(isReadingRow);

export const isRequestRow = shaped<RequestRow>({
  ...followUpShape,
  id: isInteger,
  invoice_access_key: isString,
  request_type: oneOf<RequestType>('return_note'), // ADR-002
  recipient: isString,
  subject: isString,
  asks: arrayOf(isString),
  note: isUnknown,
  due_on: isIsoDate,
  status: oneOf<RequestStatus>('draft', 'sent', 'send_failed', 'discarded'), // ADR-002
  history: arrayOf(isUnknown),
  kit_fornecedores: nullable(isSupplier),
  supplier_reply_readings: isReadings,
} satisfies Shape<RequestRow>);

const corrupt = (detail: string): never => {
  throw new SupabaseRestError('parse', OUTBOX_TABLE, 0, detail);
};

const instant = (value: string): Date => {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? corrupt('carimbo da cobrança fora do formato') : at;
};

/** #157: a ação da entrada do histórico que guarda a confirmação do documento (supabase/persistence-supplier-reply.md). */
export const CONFIRMED_ACTION = 'document_confirmed';

/**
 * #157 (ADR-005): as confirmações gravadas no histórico da linha, em ordem. A entrada fora do formato (sem documento, sem quem ou com
 * carimbo que não é data) não é confirmação: é ignorada, nunca lançada, porque o histórico é de várias gravações e esta só lê a sua.
 */
export function confirmationsOf(history: readonly unknown[]): DocumentConfirmation[] {
  const found: DocumentConfirmation[] = [];
  for (const entry of history) {
    if (!isRecord(entry) || entry.action !== CONFIRMED_ACTION) continue;
    const { document, by, at } = entry;
    if (!isString(document) || !isString(by) || !isString(at) || Number.isNaN(Date.parse(at))) continue;
    found.push({ document, by, at: new Date(at) });
  }
  return found;
}

/** #157: o estado da cobrança nas colunas; o carimbo só existe com as quatro partes (a migração garante). */
export function followUpOf(row: FollowUpColumns): FollowUpState {
  const { follow_up_sent_at: at, follow_up_sent_by: by, follow_up_channel: channel, follow_up_provider_message_id: providerMessageId } = row;
  const complete = at !== null && by !== null && channel !== null && providerMessageId !== null;
  const stored = row.follow_up_draft;
  return {
    draft: stored === null ? null : { subject: stored.subject, body: stored.body, asks: stored.asks },
    dueOn: stored?.dueOn ?? null,
    rejection: row.follow_up_rejection,
    sent: complete ? { by, at: instant(at), channel, providerMessageId } : null,
    failure: row.follow_up_failure,
  };
}

/** #157: a linha lida e o número da nota de origem viram o pedido da leitura; a leitura atual vem da projeção do log. */
export function toReplyRequest(row: RequestRow, invoiceNumber: string): ReplyRequest {
  const reading = currentReading(row.supplier_reply_readings.map(readingFromRow))?.reading ?? null;
  return {
    id: row.id,
    invoiceAccessKey: row.invoice_access_key,
    invoiceNumber,
    supplierName: row.kit_fornecedores?.razao_social ?? null,
    requestType: row.request_type,
    to: row.recipient,
    note: noteFromJson(row.note, OUTBOX_TABLE),
    asks: row.asks,
    subject: row.subject,
    dueOn: row.due_on,
    status: row.status,
    reading,
    documentConfirmation: confirmationOf(reading, confirmationsOf(row.history)),
    followUp: followUpOf(row),
  };
}

/** #157: o histórico leva o `state` da última entrada, copiado: a cobrança não muda o estado do pedido (#156). */
export function lastState(history: readonly unknown[]): unknown {
  const last = history.at(-1);
  return typeof last === 'object' && last !== null && 'state' in last ? last.state : null;
}

/** #157: o estado da cobrança depois da gravação, como entra no histórico: nomes e marcas, nunca o texto do rascunho. */
export type FollowUpSummary = {
  readonly drafted: boolean;
  readonly rejection: string | null;
  readonly claimed: boolean;
  readonly sent: boolean;
  readonly failure: string | null;
};

export const followUpSummary = (row: FollowUpColumns): FollowUpSummary => ({
  drafted: row.follow_up_draft !== null,
  rejection: row.follow_up_rejection,
  claimed: row.follow_up_claimed_at !== null,
  sent: row.follow_up_sent_at !== null,
  failure: row.follow_up_failure,
});
