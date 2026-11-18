import type { Ask } from '../claude/client.js';
import {
  buildSupplierRequestFacts,
  validateRequestText,
  type IssuedReturnNote,
  type RequestTextRejection,
  type SupplierRequestText,
} from '../domain/index.js';
import { draftRequest, todayIso, type DraftResult } from './draft.js';
import { kitNoteAttachment, kitNotePdfAttachment } from './kit-note.js';
import type { MailMessage, MailResult, RequestRecord, SourceInvoice, SupplierDeps } from './ports.js';

// #156: os casos de uso do pedido ao fornecedor (#156): emitir e enviar, editar o corpo, descartar e refazer.
// #156: cada um devolve um resultado tipado que a camada da API mapeia para HTTP; aqui não há HTTP.
// #156: cada escrita confirma sozinha (PostgREST não tem transação entre tabelas); o pedido (SupplierRequest) é a raiz que manda.
// #156: a ordem do envio é: conferir a fila, emitir (idempotente por devolução), registrar no pedido, mover a fila (com guarda),
// #156: enviar o e-mail e marcar. Uma falha no meio deixa um estado que reenviar conserta, sem segunda nota: a janela é entre
// #156: emitir e registrar (a emissão idempotente devolve a mesma nota) e entre mover a fila e marcar (o reenvio vê a fila emitida
// #156: com o número do pedido e segue). A transação de um só commit, se vier, é da unidade de trabalho do OLTP, não daqui.
// #156: o envio toma a trava (claimSend) antes de qualquer efeito: só um envio por vez emite, move a fila e manda o e-mail.
// #156: a chave da trava viaja no `RequestChange` de cada gravação do envio e em `releaseSend`; o adaptador não a guarda.
// #156: gravação que não acha a versão lida volta `stale` e vira conflito; ninguém grava por cima de outra pessoa.

const SEND_FAILED_FALLBACK = 'send_failed';
const MAILER_ERROR = 'mailer_error';

export type SendResult =
  | { readonly kind: 'ok'; readonly record: RequestRecord; readonly issued: IssuedReturnNote }
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'conflict';
      readonly reason: 'not_sendable' | 'queue_not_pending' | 'queue_entry_missing' | 'issuance_missing' | 'send_in_progress' | 'stale';
    }
  | { readonly kind: 'invalid'; readonly reason: 'source_missing' | 'text_invalid' }
  | { readonly kind: 'send_failed'; readonly record: RequestRecord; readonly reason: string };

export type EditResult =
  | { readonly kind: 'ok'; readonly record: RequestRecord; readonly rendered: SupplierRequestText }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly reason: 'not_draft' | 'stale' }
  | { readonly kind: 'invalid'; readonly reason: 'source_missing' }
  | ({ readonly kind: 'invalid' } & Pick<RequestTextRejection, 'reason' | 'field'>);

export type DiscardResult =
  | { readonly kind: 'ok'; readonly record: RequestRecord }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly reason: 'not_draft' | 'stale' }
  | { readonly kind: 'invalid'; readonly reason: 'reason_required' };

export type RedraftResult = DraftResult | { readonly kind: 'not_found' };

export type SupplierUseCases = {
  /** #156, AC-5: emite a nota (uma vez só), passa a fila para emitida e envia o e-mail com a nota anexa. */
  send(id: number, by: string): Promise<SendResult>;
  /** #156: troca só o corpo de um rascunho (forma com {{chave}}), revalidado contra o catálogo. */
  editBody(id: number, body: string, by: string): Promise<EditResult>;
  /** #156: descarta um rascunho, com o motivo e quem descartou. */
  discard(id: number, by: string, reason: string): Promise<DiscardResult>;
  /** #156: novo rascunho da devolução de um pedido já feito, só se não houver pedido aberto da nota. */
  redraft(id: number, ask: Ask): Promise<RedraftResult>;
};

/** #156: o catálogo do pedido é refeito da nota guardada, da nota de origem e do prazo gravado. */
const catalogOf = (record: RequestRecord, source: SourceInvoice) =>
  buildSupplierRequestFacts(record.request.note, source.invoice, record.request.dueOn);

const STALE: SendResult = { kind: 'conflict', reason: 'stale' };

/** #156: a nota emitida é a do pedido; sem ela, emite (idempotente por devolução) e registra. */
async function ensureIssued(deps: SupplierDeps, record: RequestRecord, by: string, claim: string): Promise<IssuedReturnNote | 'stale' | null> {
  const { request } = record;
  if (request.issuedNote !== null) return request.issuedNote;
  if (request.status !== 'draft') return null;
  const now = deps.clock.now();
  const issued = await deps.notes.issue(record.queueId, request.note, todayIso(now));
  request.recordIssuance(issued);
  const saved = await deps.requests.save(request, { by, at: now, action: 'issued', claim });
  return saved === 'ok' ? issued : 'stale';
}

/** #156: a fila é conferida ANTES de emitir: pendente, ou emitida com o número já emitido deste pedido (reenvio). */
async function checkQueue(deps: SupplierDeps, record: RequestRecord): Promise<'pending' | 'already_moved' | SendResult> {
  const now = deps.clock.now();
  const pending = (await deps.queue.list('pendente', now)).find((e) => e.id === record.queueId);
  if (pending !== undefined) return 'pending';
  const done = (await deps.queue.list('emitida', now)).find((e) => e.id === record.queueId);
  if (done !== undefined) {
    const issuedNumber = record.request.issuedNote?.number;
    return issuedNumber !== undefined && done.emitted?.number === String(issuedNumber) ? 'already_moved' : { kind: 'conflict', reason: 'queue_not_pending' };
  }
  const cancelled = (await deps.queue.list('cancelada', now)).find((e) => e.id === record.queueId);
  return { kind: 'conflict', reason: cancelled === undefined ? 'queue_entry_missing' : 'queue_not_pending' };
}

/** #156: a devolução pendente vira emitida com o número; se mudou entre a conferência e agora, é conflito. */
async function moveQueue(deps: SupplierDeps, record: RequestRecord, issued: IssuedReturnNote, by: string): Promise<SendResult | null> {
  const moved = await deps.queue.emit(record.queueId, String(issued.number), by, deps.clock.now());
  if (moved.kind === 'ok') return null;
  return { kind: 'conflict', reason: moved.kind === 'not_found' ? 'queue_entry_missing' : 'queue_not_pending' };
}

/** #156: o envio; falha do envio, ou erro lançado pela porta, vira send_failed com um motivo sem o texto do erro. */
async function mail(
  deps: SupplierDeps,
  record: RequestRecord,
  message: MailMessage,
  issuedNoteId: number,
  by: string,
  claim: string,
): Promise<SendResult | null> {
  const at = deps.clock.now();
  let result: MailResult;
  try {
    result = await deps.mailer.send(message);
  } catch {
    // #156: o texto do erro da porta não vai para o pedido nem para quem chama (layer-exposure).
    result = { ok: false, reason: MAILER_ERROR };
  }
  if (result.ok) {
    record.request.markSent();
    // #156: o anexo vai para o pedido como referência à nota emitida, não como cópia do conteúdo.
    const attachments = message.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      issuedReturnNoteId: issuedNoteId,
    }));
    const saved = await deps.requests.save(record.request, {
      by,
      at,
      action: 'sent',
      claim,
      sent: { channel: result.channel, providerMessageId: result.providerMessageId, attachments },
    });
    return saved === 'ok' ? null : STALE;
  }
  const reason = result.reason.trim() === '' ? SEND_FAILED_FALLBACK : result.reason;
  record.request.markSendFailed(reason);
  const saved = await deps.requests.save(record.request, { by, at, action: 'send_failed', claim });
  return saved === 'ok' ? { kind: 'send_failed', record, reason } : STALE;
}

/** #156: o que sobra do envio antes do e-mail: o resultado que o encerra, ou a mensagem pronta e a nota emitida. */
type Prepared = { readonly done: SendResult } | { readonly message: MailMessage; readonly issued: IssuedReturnNote };

/** #156: os passos antes do e-mail (fila, emissão, registro, movimento da fila); quem chama solta a trava se algum lança. */
async function prepareSend(deps: SupplierDeps, record: RequestRecord, rendered: SupplierRequestText, claim: string, by: string): Promise<Prepared> {
  const { request } = record;
  const gate = await checkQueue(deps, record);
  if (typeof gate === 'object') return { done: gate };
  const issued = await ensureIssued(deps, record, by, claim);
  if (issued === 'stale') return { done: STALE };
  if (issued === null) return { done: { kind: 'conflict', reason: 'issuance_missing' } };
  const blocked = gate === 'pending' ? await moveQueue(deps, record, issued, by) : null;
  if (blocked !== null) return { done: blocked };
  const message: MailMessage = {
    invoiceAccessKey: request.invoiceAccessKey,
    supplierId: issued.supplierId,
    requestType: request.requestType,
    to: record.to,
    ...rendered,
    attachments: [kitNoteAttachment(issued), kitNotePdfAttachment(issued)], // #156: o PDF sai da nota emitida, então o reenvio leva o mesmo
    dueOn: request.dueOn,
    idempotencyKey: claim,
  };
  return { message, issued };
}

/** #156: um erro antes do e-mail solta a trava e sobe; o e-mail ainda não saiu, então o reenvio não abre segundo e-mail. */
async function prepareOrRelease(deps: SupplierDeps, id: number, record: RequestRecord, rendered: SupplierRequestText, claim: string, by: string): Promise<Prepared> {
  try {
    return await prepareSend(deps, record, rendered, claim, by);
  } catch (error) {
    // #156: se soltar também falhar, a trava vence sozinha pelo prazo (LEASE_MS) e o erro original é o que sobe.
    await deps.requests.releaseSend(id, claim, by, deps.clock.now()).catch(() => undefined);
    throw error;
  }
}

async function send(deps: SupplierDeps, id: number, by: string): Promise<SendResult> {
  const record = await deps.requests.get(id);
  if (record === null) return { kind: 'not_found' };
  const { request } = record;
  if (request.status !== 'draft' && request.status !== 'send_failed') return { kind: 'conflict', reason: 'not_sendable' };
  const source = await deps.source.find(request.invoiceAccessKey);
  if (source === null) return { kind: 'invalid', reason: 'source_missing' };
  const text = validateRequestText({ subject: request.subject, body: request.body, asks: request.asks }, catalogOf(record, source));
  if (!text.ok) return { kind: 'invalid', reason: 'text_invalid' };
  const claimed = await deps.requests.claimSend(id, by, deps.clock.now());
  if (claimed.kind === 'conflict') return { kind: 'conflict', reason: 'send_in_progress' };
  const prepared = await prepareOrRelease(deps, id, record, text.rendered, claimed.claim, by);
  // #156: o envio que para antes do e-mail solta a trava aqui, pela chave dela; o que chega ao e-mail a limpa no último save.
  if ('done' in prepared) {
    await deps.requests.releaseSend(id, claimed.claim, by, deps.clock.now());
    return prepared.done;
  }
  const { message, issued } = prepared;
  return (await mail(deps, record, message, issued.number, by, claimed.claim)) ?? { kind: 'ok', record, issued };
}

async function editBody(deps: SupplierDeps, id: number, body: string, by: string): Promise<EditResult> {
  const record = await deps.requests.get(id);
  if (record === null) return { kind: 'not_found' };
  if (record.request.status !== 'draft') return { kind: 'conflict', reason: 'not_draft' };
  const source = await deps.source.find(record.request.invoiceAccessKey);
  if (source === null) return { kind: 'invalid', reason: 'source_missing' };
  const result = record.request.editBody(body, catalogOf(record, source));
  if (!result.ok) return { kind: 'invalid', reason: result.reason, field: result.field };
  const saved = await deps.requests.save(record.request, { by, at: deps.clock.now(), action: 'edited' });
  if (saved === 'stale') return { kind: 'conflict', reason: 'stale' };
  return { kind: 'ok', record, rendered: result.rendered };
}

async function discard(deps: SupplierDeps, id: number, by: string, reason: string): Promise<DiscardResult> {
  const record = await deps.requests.get(id);
  if (record === null) return { kind: 'not_found' };
  if (record.request.status !== 'draft') return { kind: 'conflict', reason: 'not_draft' };
  if (reason.trim() === '') return { kind: 'invalid', reason: 'reason_required' };
  record.request.discard(reason);
  const saved = await deps.requests.save(record.request, { by, at: deps.clock.now(), action: 'discarded' });
  if (saved === 'stale') return { kind: 'conflict', reason: 'stale' };
  return { kind: 'ok', record };
}

async function redraft(deps: SupplierDeps, id: number, ask: Ask): Promise<RedraftResult> {
  const previous = await deps.requests.get(id);
  if (previous === null) return { kind: 'not_found' };
  return draftRequest(deps, previous.queueId, ask);
}

/** #156: os casos de uso ligados às portas. */
export const createSupplierUseCases = (deps: SupplierDeps): SupplierUseCases => ({
  send: (id, by) => send(deps, id, by),
  editBody: (id, body, by) => editBody(deps, id, body, by),
  discard: (id, by, reason) => discard(deps, id, by, reason),
  redraft: (id, ask) => redraft(deps, id, ask),
});
