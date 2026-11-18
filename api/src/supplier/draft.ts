import { DEFAULT_MODEL, type Ask } from '../claude/client.js';
import {
  DEFAULT_DUE_BUSINESS_DAYS,
  DomainError,
  addBusinessDays,
  buildReturnNote,
  buildSupplierRequestFacts,
  validateRequestText,
  type FactCatalog,
  type ReturnNoteDraft,
  type SupplierRequestText,
} from '../domain/index.js';
import type { ReturnNoteView } from '../returns/return-notes.js';
import { buildSupplierRequestPrompt } from './prompt.js';
import type { DraftOutcome, RequestRecord, SupplierDeps } from './ports.js';

// #156: o caminho único do rascunho (#156): a tarefa do Cron e o "refazer" da pessoa passam por aqui.
// #156: preparar o rascunho nunca emite nota nem envia e-mail (#156).

const REQUEST_TYPE = 'return_note';
/** #156: quem consta no histórico de um rascunho: o agente do Claude, no Cron e no refazer. */
export const AGENT_ACTOR = 'agente';

export type DraftResult =
  | { readonly kind: 'ok'; readonly record: RequestRecord }
  | { readonly kind: 'conflict'; readonly reason: 'open_request_exists' | 'queue_not_pending' }
  | { readonly kind: 'invalid'; readonly reason: 'source_missing' | 'note_not_buildable' };

const TIME_ZONE = 'America/Sao_Paulo';

/** #156: o dia de hoje no fuso do caso, AAAA-MM-DD (o en-CA formata assim). */
export const todayIso = (now: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now);

/** #156: a devolução da fila como o rascunho a usa: o id, a chave da nota de origem e as linhas (código, quantidade, unidade). */
export type QueueEntry = {
  readonly id: number;
  readonly invoiceAccessKey: string;
  readonly lines: readonly { readonly supplierCode: string; readonly amount: number; readonly unit: 'UN' | 'CX' }[];
};

export const queueEntryOf = (entry: ReturnNoteView): QueueEntry => ({
  id: entry.id,
  invoiceAccessKey: entry.invoiceAccessKey,
  lines: entry.lines.map((l) => ({ supplierCode: l.supplierCode, amount: l.quantity.amount, unit: l.quantity.unit })),
});

/** #156: o que o Claude escreveu, aceito pelo catálogo ou recusado com o motivo. */
function judge(raw: unknown, catalog: FactCatalog): DraftOutcome {
  const checked = validateRequestText(raw, catalog);
  if (!checked.ok) return { kind: 'rejected', rejection: checked };
  const text: SupplierRequestText = checked.text;
  return { kind: 'draft', text };
}

// #156: prepara o rascunho da devolução `queueId` da fila: a nota pela regra, o e-mail pelo Claude.
// #156: erro do Claude (inclusive 401 e 429) sobe como está: nada é gravado.
export async function draftRequest(deps: SupplierDeps, queueId: number, ask: Ask): Promise<DraftResult> {
  const found = (await deps.queue.list('pendente', deps.clock.now())).find((e) => e.id === queueId);
  if (found === undefined) return { kind: 'conflict', reason: 'queue_not_pending' };
  const entry = queueEntryOf(found);
  if ((await deps.requests.findOpen(entry.invoiceAccessKey, REQUEST_TYPE)) !== null) {
    return { kind: 'conflict', reason: 'open_request_exists' };
  }
  return draftFromEntry(deps, entry, ask);
}

// #156: o rascunho de uma devolução que quem chama já leu (a tarefa do Cron guarda a entrada no `pending()`): não relê a fila
// #156: nem o pedido aberto, para caber no orçamento de subrequests; a corrida com outro pedido volta pelo conflito do `create`.
export async function draftFromEntry(deps: SupplierDeps, entry: QueueEntry, ask: Ask): Promise<DraftResult> {
  const now = deps.clock.now();
  const source = await deps.source.find(entry.invoiceAccessKey);
  if (source === null) return { kind: 'invalid', reason: 'source_missing' };
  let note: ReturnNoteDraft;
  try {
    note = buildReturnNote({ invoiceAccessKey: entry.invoiceAccessKey, lines: [...entry.lines] }, source.invoice);
  } catch (error) {
    if (error instanceof DomainError) return { kind: 'invalid', reason: 'note_not_buildable' };
    throw error;
  }
  const draftedOn = todayIso(now);
  const dueOn = addBusinessDays(draftedOn, DEFAULT_DUE_BUSINESS_DAYS);
  const catalog = buildSupplierRequestFacts(note, source.invoice, dueOn);
  const raw = await ask<unknown>(buildSupplierRequestPrompt(catalog, REQUEST_TYPE));
  const created = await deps.requests.create({
    invoiceAccessKey: entry.invoiceAccessKey,
    queueId: entry.id,
    note,
    to: source.supplierEmail,
    draftedOn,
    model: DEFAULT_MODEL,
    by: AGENT_ACTOR,
    outcome: judge(raw, catalog),
  });
  return created.kind === 'ok' ? { kind: 'ok', record: created.record } : { kind: 'conflict', reason: 'open_request_exists' };
}
