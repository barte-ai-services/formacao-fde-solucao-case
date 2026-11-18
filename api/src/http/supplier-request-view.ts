// #156: a visão do pedido ao fornecedor (#156) como a API a entrega; o formato é o autorado no cabeçalho de supplier-requests.ts.
// #156: a visão é montada campo a campo: nada do agregado, da linha ou da fila sai que não esteja nomeado aqui (layer-exposure).
import {
  Money,
  buildSupplierRequestFacts,
  validateRequestText,
  type IssuedReturnNote,
  type ReturnNoteDraft,
} from '../domain/index.js';
import { noteFilename } from '../supplier/kit-note.js';
import type { RequestRecord, SourceInvoice } from '../supplier/ports.js';
import type { ReplyRequest } from '../supplier/reply-ports.js';
import { confirmationOf, followUpOf, readingOf, type WireDocumentConfirmation, type WireFollowUp, type WireReading } from './supplier-reply-view.js';

export type WireMoney = { readonly text: string };

export type WireNote = {
  /** #156: o número da nota emitida (ND-n); `null` antes da emissão, nunca ausente. */
  readonly number: string | null;
  /** #156: o código do fornecedor (o nome não está na nota de origem que a camada de baixo lê). */
  readonly supplier: string;
  /** #156: o número da nota de origem. */
  readonly reference: string;
  readonly lines: readonly { readonly description: string; readonly quantity: string; readonly unitPrice: WireMoney; readonly total: WireMoney }[];
  readonly total: WireMoney;
};

type WireContent = {
  readonly invoiceAccessKey: string;
  readonly requestType: 'return_note';
  readonly returnNote: WireNote;
  readonly email: { readonly to: string; readonly dueOn: string; readonly subject: string; readonly body: string; readonly template: string };
  readonly asks: readonly string[];
  readonly attachment?: { readonly name: string; readonly url: string };
};

export type WireRequest =
  | { readonly status: 'writing' }
  | ({ readonly status: 'draft' } & WireContent) // ADR-002
  // #157: o pedido enviado ganha a leitura da resposta (#157) e a cobrança; os campos da #156 ficam como estavam.
  // #157: e a confirmação do documento citado na leitura (nula enquanto a pessoa não confirmou).
  | ({
      readonly status: 'sent'; // ADR-002
      readonly sentBy: string | null;
      readonly sentAt: string | null;
      readonly reading: WireReading | null;
      readonly documentConfirmation: WireDocumentConfirmation | null;
      readonly followUp: WireFollowUp;
    } & WireContent)
  | ({ readonly status: 'send_failed'; readonly failure: string } & WireContent) // ADR-002
  | { readonly status: 'discarded'; readonly discardedAt: string | null; readonly discardedBy: string | null } // ADR-002
  | { readonly status: 'failed'; readonly failure: 'number_mismatch' | 'invalid_shape' };

export type ViewResult = { readonly ok: true; readonly view: WireRequest } | { readonly ok: false; readonly reason: 'source_missing' | 'text_invalid' };

/** #157: o pedido enviado sem a leitura da #157 à mão (não deve ocorrer): a cobrança vazia. */
const NO_FOLLOW_UP: WireFollowUp = { drafted: false, sent: false, draft: null, dueOn: null, sentBy: null, sentAt: null, failure: null };

/** #156: o dinheiro em reais, em texto pt-BR, feito no servidor a partir do valor da nota. */
const money = (reais: number): WireMoney => ({ text: Money.fromReais(reais).toString() });

/** #156: a URL do anexo é a da própria API, por chave de acesso da nota de origem. #156: o anexo da gaveta é o PDF. */
export const noteUrl = (invoiceAccessKey: string): string => `/api/supplier-requests/${invoiceAccessKey}/return-note.pdf`;

function noteOf(draft: ReturnNoteDraft, issued: IssuedReturnNote | null, reference: string): WireNote {
  return {
    number: issued === null ? null : issued.noteId,
    supplier: draft.supplierId,
    reference,
    lines: draft.items.map((item) => ({
      description: item.description,
      quantity: `${item.quantity} ${item.unit}`,
      unitPrice: money(item.unitPrice),
      total: money(item.value),
    })),
    total: money(draft.total),
  };
}

/** #156 (#156): o pedido que nasceu descartado pelo agente guarda "motivo: campo"; a visão mostra só o motivo. */
function agentFailure(reason: string | null): 'number_mismatch' | 'invalid_shape' {
  return reason?.startsWith('number_mismatch') === true ? 'number_mismatch' : 'invalid_shape';
}

/** #156: o pedido que o Claude escreveu e a regra recusou nasce descartado e sem texto. */
const bornDiscarded = (record: RequestRecord): boolean => record.request.status === 'discarded' && record.request.subject === ''; // ADR-002

/** #156: monta a visão; sem a nota de origem (e do e-mail do fornecedor) ou com texto que já não confere, diz por quê. */
export function viewOf(record: RequestRecord, source: SourceInvoice | null, reply: ReplyRequest | null = null): ViewResult {
  const { request } = record;
  if (request.status === 'discarded') { // ADR-002
    if (bornDiscarded(record)) return { ok: true, view: { status: 'failed', failure: agentFailure(request.discardReason) } };
    const { audit } = record;
    return { ok: true, view: { status: 'discarded', discardedAt: audit?.discardedAt ?? null, discardedBy: audit?.discardedBy ?? null } }; // ADR-002
  }
  if (source === null) return { ok: false, reason: 'source_missing' };
  const catalog = buildSupplierRequestFacts(request.note, source.invoice, request.dueOn);
  const text = validateRequestText({ subject: request.subject, body: request.body, asks: request.asks }, catalog);
  if (!text.ok) return { ok: false, reason: 'text_invalid' };
  const issued = request.issuedNote;
  const content: WireContent = {
    invoiceAccessKey: request.invoiceAccessKey,
    requestType: request.requestType,
    returnNote: noteOf(request.note, issued, source.invoice.number),
    email: { to: record.to, dueOn: request.dueOn, subject: text.rendered.subject, body: text.rendered.body, template: request.body },
    asks: text.rendered.asks,
    ...(issued === null ? {} : { attachment: { name: noteFilename(issued, 'pdf'), url: noteUrl(request.invoiceAccessKey) } }),
  };
  if (request.status === 'sent') { // ADR-002
    const sent = { sentBy: record.audit?.sentBy ?? null, sentAt: record.audit?.sentAt ?? null };
    const documentConfirmation = confirmationOf(reply?.documentConfirmation ?? null); // #157
    return { ok: true, view: { status: 'sent', ...sent, reading: readingOf(reply?.reading ?? null), documentConfirmation, followUp: reply === null ? NO_FOLLOW_UP : followUpOf(reply), ...content } }; // ADR-002
  }
  if (request.status === 'send_failed') { // ADR-002
    return { ok: true, view: { status: 'send_failed', failure: request.sendFailureReason ?? 'send_failed', ...content } }; // ADR-002
  }
  return { ok: true, view: { status: 'draft', ...content } }; // ADR-002
}
