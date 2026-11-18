// #157: a leitura da resposta do fornecedor (#157) e a cobrança como a API as entrega; o formato é o autorado no cabeçalho de supplier-requests.ts.
// #157: montada campo a campo: nada da linha, da ficha da reivindicação nem do histórico sai que não esteja nomeado aqui (layer-exposure).
import { validateRequestText, type DocumentConfirmation, type NextStep, type ReplyOutcome, type RequestFilter, type RequestStatus, type SupplierReading } from '../domain/index.js';
import { followUpCatalogOf } from '../supplier/reply-catalog.js';
import type { ReplyList, ReplyListRow, ReplyRequest } from '../supplier/reply-ports.js';

export type WireReading = {
  readonly replyOutcome: ReplyOutcome;
  readonly fulfilledAsks: readonly string[];
  readonly supplierDocument: string | null;
  readonly summary: string;
  readonly nextStep: NextStep;
  /** #157: o trecho da resposta com uma ordem escondida, citado como o fornecedor escreveu; é dado, nunca instrução. */
  readonly injectionFlag: string | null;
};

/** #157 (ADR-005): o documento confirmado, quem confirmou (o e-mail do Access) e quando (ISO 8601, UTC). */
export type WireDocumentConfirmation = { readonly document: string; readonly by: string; readonly at: string };

export type WireFollowUp = {
  readonly drafted: boolean;
  readonly sent: boolean;
  /** #157: o rascunho da cobrança: o texto renderizado e a forma com {{chave}}; nulo sem rascunho. */
  readonly draft: { readonly subject: string; readonly body: string; readonly template: string; readonly asks: readonly string[] } | null;
  /** #157, #157: o novo prazo da cobrança ('AAAA-MM-DD'), o que a regra gravou com o rascunho; nulo sem rascunho (ou no do Claude, de antes da #157). */
  readonly dueOn: string | null;
  readonly sentBy: string | null;
  readonly sentAt: string | null;
  /** #157: o motivo curto da última falha do envio; nunca o texto do provedor. */
  readonly failure: string | null;
};

export type WireListRow = {
  readonly id: number;
  readonly invoiceAccessKey: string;
  readonly invoiceNumber: string;
  readonly supplierId: string;
  readonly supplierName: string | null;
  readonly requestType: 'return_note';
  /** #157: o total da nota de devolução em centavos (inteiro); a tela formata. */
  readonly totalCents: number;
  readonly dueOn: string;
  readonly status: RequestStatus;
  readonly reading: WireReading | null;
  readonly followUp: { readonly drafted: boolean; readonly sent: boolean };
};

export type WireReadingList = {
  readonly filter: RequestFilter;
  readonly requests: readonly WireListRow[];
  readonly counts: Readonly<Record<RequestFilter, number>>;
};

/** #157: a confirmação como a API a entrega, campo a campo; nula enquanto a pessoa não confirmou. */
export const confirmationOf = (confirmation: DocumentConfirmation | null): WireDocumentConfirmation | null =>
  confirmation === null ? null : { document: confirmation.document, by: confirmation.by, at: confirmation.at.toISOString() };

export const readingOf = (reading: SupplierReading | null): WireReading | null =>
  reading === null
    ? null
    : {
        replyOutcome: reading.replyOutcome,
        fulfilledAsks: [...reading.fulfilledAsks],
        supplierDocument: reading.supplierDocument,
        summary: reading.summary,
        nextStep: reading.nextStep,
        injectionFlag: reading.injectionFlag,
      };

/** #157: o rascunho que já não confere com o catálogo (a nota guardada mudou) não é mostrado: um texto que a regra recusa não vai à pessoa. */
function renderedDraft(reply: ReplyRequest): WireFollowUp['draft'] {
  const { draft } = reply.followUp;
  if (draft === null) return null;
  const checked = validateRequestText(draft, followUpCatalogOf(reply));
  return checked.ok ? { ...checked.rendered, template: draft.body } : null;
}

export const followUpOf = (reply: ReplyRequest): WireFollowUp => {
  const { sent, failure } = reply.followUp;
  return {
    drafted: reply.followUp.draft !== null,
    sent: sent !== null,
    draft: renderedDraft(reply),
    dueOn: reply.followUp.dueOn,
    sentBy: sent?.by ?? null,
    sentAt: sent?.at.toISOString() ?? null,
    failure,
  };
};

const toCents = (reais: number): number => Math.round(reais * 100);

const rowOf = (row: ReplyListRow): WireListRow => ({
  id: row.id,
  invoiceAccessKey: row.invoiceAccessKey,
  invoiceNumber: row.invoiceNumber,
  supplierId: row.supplierId,
  supplierName: row.supplierName,
  requestType: row.requestType,
  totalCents: toCents(row.totalValue),
  dueOn: row.dueOn,
  status: row.status,
  reading: readingOf(row.reading),
  followUp: { drafted: row.followUpDrafted, sent: row.followUpSent },
});

export const listOf = (list: ReplyList): WireReadingList => ({
  filter: list.filter,
  requests: list.rows.map(rowOf),
  counts: { awaiting: list.counts.awaiting, answered: list.counts.answered, needs_you: list.counts.needs_you, overdue: list.counts.overdue },
});
