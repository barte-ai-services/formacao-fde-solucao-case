import { confirmRefusal, filterOf, followUpDraftFor, followUpDue, overdueReading, owesFollowUp, validateRequestText, type DocumentConfirmation, type RequestFilter, type SupplierReading, type TextField } from '../domain/index.js';
import { followUpCatalogOf, todayIso } from './reply-catalog.js';
import type { FollowUpMail, FollowUpMailResult, FollowUpStamp, ReplyDeps, ReplyList, ReplyListRow, ReplyRequest } from './reply-ports.js';

// #34: os casos de uso da leitura da resposta (#4): a varredura do prazo (que monta a cobrança pela regra, #58), a edição e o envio da cobrança e a lista.
// #34: cada um devolve um resultado tipado que a camada da API mapeia para HTTP; aqui não há HTTP.

const SEND_FAILED_FALLBACK = 'send_failed';
const MAILER_ERROR = 'mailer_error';
const SHORT_REASON = /^[a-z][a-z0-9_]{0,39}$/;

export type SendFollowUpResult =
  | { readonly kind: 'ok'; readonly request: ReplyRequest }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly reason: 'not_follow_up' | 'no_draft' | 'already_sent' | 'send_in_progress' | 'stale' }
  | { readonly kind: 'invalid'; readonly reason: 'text_invalid' }
  | { readonly kind: 'send_failed'; readonly reason: string };

/** #58/AC-4, AC-5: o que a edição do texto da cobrança devolve; a camada da API mapeia para HTTP. */
export type EditFollowUpResult =
  | { readonly kind: 'ok'; readonly request: ReplyRequest }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly reason: 'no_draft' | 'already_sent' | 'send_in_progress' | 'stale' }
  | { readonly kind: 'invalid'; readonly reason: 'number_mismatch' | 'invalid_shape'; readonly field: TextField };

/** #63/AC-1, AC-4: o que a confirmação do documento devolve; a camada da API mapeia para HTTP. */
export type ConfirmDocumentResult =
  | { readonly kind: 'ok'; readonly request: ReplyRequest }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly reason: 'not_confirm_document' | 'already_confirmed' | 'stale' };

export type SweepResult = {
  /** #34/AC-3: os pedidos que a varredura marcou no_reply agora. */
  readonly marked: readonly number[];
  /** #58/AC-1: os pedidos que ganharam o rascunho da cobrança agora: os marcados e os já marcados que ficaram sem o rascunho. */
  readonly drafted: readonly number[];
};

export type ReplyUseCases = {
  /**
   * #34/AC-3: cada pedido `sent` sem leitura depois do prazo vira no_reply com follow_up; sem Claude, sem envio.
   * #58/AC-1: e ganha, na mesma varredura, o rascunho da cobrança montado pela regra (o pedido já no_reply que ficou sem rascunho,
   * numa rodada que caiu entre as duas gravações, ganha na seguinte). Nada é enviado: o envio é do `sendFollowUp` (#58/AC-7).
   * #58/AC-2: o pedido cuja leitura é a resposta `partially_fulfilled` ou `needs_information` com next_step follow_up também ganha a cobrança
   * (só dos itens que faltam), passado o prazo do pedido; a leitura do fornecedor fica, a varredura não grava outra.
   * #36/AC-4: trata no máximo `limit` pedidos por chamada (os de menor id); a chamada seguinte trata os próximos.
   */
  sweepOverdue(limit?: number): Promise<SweepResult>;
  /** #58/AC-4: troca o texto (o corpo, revalidado) da cobrança ainda não enviada; só uma pessoa chama, e fica gravado quem. */
  editFollowUp(id: number, template: string, by: string): Promise<EditFollowUpResult>;
  /** #34/AC-4: envia a cobrança rascunhada; só uma pessoa chama, e fica gravado quem e quando. */
  sendFollowUp(id: number, by: string): Promise<SendFollowUpResult>;
  /**
   * #63/AC-1: confirma o documento citado na leitura do pedido em `confirm_document`; só uma pessoa chama, e fica gravado quem e quando (ADR-005).
   * #63/AC-5: só grava a confirmação: não envia nada ao fornecedor e não muda a leitura, a decisão, o título nem o valor em risco.
   */
  confirmDocument(id: number, by: string): Promise<ConfirmDocumentResult>;
  /** #34/AC-5: os pedidos de um filtro, com a leitura, e as contagens de todos os filtros. */
  listRequests(filter: RequestFilter, today: string): Promise<ReplyList>;
};

/**
 * #58/AC-1, AC-2: o pedido que já tem a leitura que pede cobrança (o no_reply, ou a resposta parcial ou de pedido de informação com
 * follow_up, passado o prazo) e espera o rascunho: sem rascunho, sem recusa antiga do Claude e sem envio.
 */
const awaitsDraft = (r: ReplyRequest, today: string): boolean =>
  followUpDue(r, r.reading, today) && r.followUp.draft === null && r.followUp.rejection === null && r.followUp.sent === null;

/** #58/AC-2, AC-4: a cobrança só existe no pedido `sent` com a leitura que a pede. */
const owesDraft = (r: ReplyRequest): boolean => r.status === 'sent' && owesFollowUp(r.reading);

/** #58/AC-1, AC-2: monta pela regra a cobrança do que a leitura não deu por atendido, com o novo prazo de hoje, e grava o rascunho. */
async function draftFollowUp(deps: ReplyDeps, request: ReplyRequest, reading: SupplierReading, today: string): Promise<void> {
  const { text, dueOn } = followUpDraftFor({ asks: request.asks, fulfilledAsks: reading.fulfilledAsks }, today);
  await deps.requests.saveFollowUpDraft(request.id, text, dueOn);
}

async function sweepOverdue(deps: ReplyDeps, limit: number = Infinity): Promise<SweepResult> {
  const today = todayIso(deps.clock.now());
  const marked: number[] = [];
  const drafted: number[] = [];
  let handled = 0;
  for (const request of await deps.requests.listSent()) {
    if (handled >= limit) break; // #36/AC-4: o teto da rodada; o resto fica para a próxima
    const overdue = overdueReading(request, request.reading, today);
    if (overdue !== null) {
      // #34/AC-3: sem mensagem de origem (null): o OLTP só grava se o pedido ainda não tem leitura.
      if ((await deps.requests.recordReading(request.id, overdue, null)) !== 'recorded') continue;
      marked.push(request.id);
      await draftFollowUp(deps, request, overdue, today);
      drafted.push(request.id);
      handled += 1;
    } else if (request.reading !== null && awaitsDraft(request, today)) {
      await draftFollowUp(deps, request, request.reading, today);
      drafted.push(request.id);
      handled += 1;
    }
  }
  return { marked, drafted };
}

/** #34/AC-4: erro lançado pela porta, ou motivo fora do formato curto, vira um motivo próprio; o texto do provedor não é gravado. */
async function dispatch(deps: ReplyDeps, requestId: number, message: FollowUpMail): Promise<FollowUpMailResult> {
  try {
    const result = await deps.mailer.send(message);
    if (result.ok) return result;
    return { ok: false, reason: SHORT_REASON.test(result.reason) ? result.reason : SEND_FAILED_FALLBACK };
  } catch (error) {
    // #34/AC-4: o texto do erro da porta não vai para o pedido nem para quem chama (layer-exposure).
    // #34/AC-4: o adaptador de #12 (mock-mailer) não registra a falha antes de lançar; aqui vai para o log do servidor
    // #34/AC-4: só a classe do erro, a operação e o pedido, como o storedError do runner (#66) faz com o que não é nosso.
    const className = error instanceof Error ? error.constructor.name : '';
    const name = /^\w{1,64}$/.test(className) ? className : 'Error';
    console.error('#34 envio da cobrança falhou', { operation: 'follow-up-send', requestId, error: name });
    return { ok: false, reason: MAILER_ERROR };
  }
}

/** #35: quem perdeu a reivindicação não grava; o log leva só a operação e o pedido (nunca a ficha) e o resultado é o conflito. */
function lostClaim(requestId: number, operation: string): SendFollowUpResult {
  console.error('#35 a reivindicação da cobrança foi perdida antes de gravar o resultado', { operation, requestId });
  return { kind: 'conflict', reason: 'send_in_progress' };
}

async function sendFollowUp(deps: ReplyDeps, id: number, by: string): Promise<SendFollowUpResult> {
  const request = await deps.requests.get(id);
  if (request === null) return { kind: 'not_found' };
  if (!owesDraft(request)) return { kind: 'conflict', reason: 'not_follow_up' };
  const { draft, sent } = request.followUp;
  if (sent !== null) return { kind: 'conflict', reason: 'already_sent' };
  if (draft === null) return { kind: 'conflict', reason: 'no_draft' };
  const text = validateRequestText(draft, followUpCatalogOf(request));
  if (!text.ok) return { kind: 'invalid', reason: 'text_invalid' };
  // #34/AC-4: a reivindicação vem antes do e-mail; quem não a ganha não envia, e a que fica presa após o envio impede o segundo e-mail.
  // #58/AC-5: sobre o texto que esta chamada leu e validou: se uma edição entrou no meio, o envio recusa (stale) em vez de mandar o texto antigo.
  const attempt = await deps.requests.claimFollowUpSend(id, by, draft);
  if (attempt.kind !== 'won') return { kind: 'conflict', reason: attempt.kind === 'stale' ? 'stale' : 'send_in_progress' };
  const claim = attempt.claim;
  const result = await dispatch(deps, id, {
    invoiceAccessKey: request.invoiceAccessKey,
    supplierId: request.note.supplierId,
    requestType: request.requestType,
    to: request.to,
    ...text.rendered,
    attachments: [],
    dueOn: request.followUp.dueOn ?? request.dueOn, // #58/AC-2: o prazo que a cobrança traz é o novo
  });
  if (!result.ok) {
    // #35: a reivindicação venceu e outro a retomou durante o envio: a falha não é mais deste pedido de envio, e quem manda agora é o outro.
    if ((await deps.requests.recordFollowUpFailure(id, claim, result.reason, by)) === 'lost') return lostClaim(id, 'follow-up-failure');
    return { kind: 'send_failed', reason: result.reason };
  }
  const stamp: FollowUpStamp = { by, at: deps.clock.now(), channel: result.channel, providerMessageId: result.providerMessageId };
  // #34/AC-4: se esta gravação falhar, o e-mail já saiu e a reivindicação só vence depois de LEASE_MS: um envio posterior pode mandar um segundo e-mail, risco aceito e documentado em supabase/persistence-supplier-reply.md (#35).
  // #35: se a reivindicação foi perdida no meio, o carimbo é do outro envio: este e-mail saiu, mas não grava nem se declara enviado.
  if ((await deps.requests.recordFollowUpSent(id, claim, stamp)) === 'lost') return lostClaim(id, 'follow-up-stamp');
  return { kind: 'ok', request: { ...request, followUp: { ...request.followUp, sent: stamp, failure: null } } };
}

/** #58/AC-4, AC-5: o estado de partida (enviado, no_reply, com rascunho ainda sem carimbo) e o texto novo revalidado contra o catálogo da cobrança. */
async function editFollowUp(deps: ReplyDeps, id: number, template: string, by: string): Promise<EditFollowUpResult> {
  const request = await deps.requests.get(id);
  if (request === null) return { kind: 'not_found' };
  const { draft, sent } = request.followUp;
  if (!owesDraft(request)) return { kind: 'conflict', reason: 'no_draft' };
  if (sent !== null) return { kind: 'conflict', reason: 'already_sent' };
  if (draft === null) return { kind: 'conflict', reason: 'no_draft' };
  // #58/AC-4: troca só o corpo, como o PATCH do rascunho da #13: o assunto e os itens ficam; o texto cru, com {{chave}}, é o que se confere e o que se guarda.
  const checked = validateRequestText({ subject: draft.subject, body: template, asks: draft.asks }, followUpCatalogOf(request));
  if (!checked.ok) return { kind: 'invalid', reason: checked.reason, field: checked.field };
  const written = await deps.requests.editFollowUpDraft(id, checked.text, by);
  if (written !== 'recorded') return { kind: 'conflict', reason: written };
  return { kind: 'ok', request: { ...request, followUp: { ...request.followUp, draft: checked.text } } };
}

/** #63/AC-2: a confirmação do pedido, no formato lista que a regra do domínio recebe. */
const confirmationsOf = (r: ReplyRequest): readonly DocumentConfirmation[] => (r.documentConfirmation === null ? [] : [r.documentConfirmation]);

/** #63/AC-1, AC-4: o pedido enviado cuja leitura pede a confirmação; o armazém grava guardado pela versão, e a recusa de corrida volta como conflito. */
async function confirmDocument(deps: ReplyDeps, id: number, by: string): Promise<ConfirmDocumentResult> {
  const request = await deps.requests.get(id);
  if (request === null) return { kind: 'not_found' };
  const refusal = confirmRefusal(request, request.reading, confirmationsOf(request));
  if (refusal !== null) return { kind: 'conflict', reason: refusal };
  const document = request.reading?.supplierDocument;
  if (document === null || document === undefined) return { kind: 'conflict', reason: 'not_confirm_document' }; // #63/AC-4: o que `confirmRefusal` já recusou; fecha o tipo
  const confirmation = { document, by, at: deps.clock.now() };
  const written = await deps.requests.confirmDocument(id, confirmation);
  if (written !== 'recorded') return { kind: 'conflict', reason: written };
  return { kind: 'ok', request: { ...request, documentConfirmation: confirmation } };
}

const rowOf = (r: ReplyRequest): ReplyListRow => ({
  id: r.id,
  invoiceAccessKey: r.invoiceAccessKey,
  invoiceNumber: r.invoiceNumber,
  supplierId: r.note.supplierId,
  supplierName: r.supplierName,
  requestType: r.requestType,
  totalValue: r.note.total,
  dueOn: r.dueOn,
  status: r.status,
  reading: r.reading,
  followUpDrafted: r.followUp.draft !== null,
  followUpSent: r.followUp.sent !== null,
});

async function listRequests(deps: ReplyDeps, filter: RequestFilter, today: string): Promise<ReplyList> {
  const counts: Record<RequestFilter, number> = { awaiting: 0, answered: 0, needs_you: 0, overdue: 0 };
  const rows: ReplyListRow[] = [];
  for (const request of await deps.requests.listSent()) {
    const placed = filterOf(request, request.reading, today, confirmationsOf(request)); // #63/AC-2: o confirmado cai em `answered`
    if (placed === null) continue;
    counts[placed] += 1;
    if (placed === filter) rows.push(rowOf(request));
  }
  return { filter, rows, counts: Object.freeze(counts) };
}

/** #34: os casos de uso ligados às portas. */
export const createReplyUseCases = (deps: ReplyDeps): ReplyUseCases => ({
  sweepOverdue: (limit) => sweepOverdue(deps, limit),
  editFollowUp: (id, template, by) => editFollowUp(deps, id, template, by),
  sendFollowUp: (id, by) => sendFollowUp(deps, id, by),
  confirmDocument: (id, by) => confirmDocument(deps, id, by),
  listRequests: (filter, today) => listRequests(deps, filter, today),
});
