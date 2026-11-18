// #13: o pedido ao fornecedor (#2) pela API: a nota de devolução e o e-mail que o agente prepara, a pessoa revisa, emite e envia.
// #13: o contrato abaixo é escrito à mão (contract-first); api/test/http/supplier-requests-contract.test.ts o fixa, uma operação por vez.
// #13:
// #13: as rotas são por chave de acesso (44 dígitos) da nota de origem, porque a tela chama assim e há no máximo um pedido
// #13: aberto por nota. "O pedido da nota" é o aberto, se houver; senão o mais recente.
// #13:
// #13:   GET   /api/supplier-requests/{accessKey}                  200 { request: SupplierRequestView | null }
// #13:           null quando a nota não tem pedido nem devolução pendente na fila; { status: 'writing' } quando a devolução
// #13:           está pendente e o Cron ainda não fez o rascunho
// #13:   PATCH /api/supplier-requests/{accessKey}  { template }    200 { request }   só o corpo de um rascunho (forma com {{chave}}), revalidado
// #13:           422 { error: 'invalid', reason: 'number_mismatch' | 'invalid_shape', field: 'subject' | 'body' | 'asks' }
// #13:   POST  /api/supplier-requests/{accessKey}/send     {}       200 { request }   só de rascunho: emite (mock), fila emitida, e-mail;
// #13:           o resultado é `sent` ou `send_failed` (falha do envio é um estado, continua 200)
// #36:           e do pedido `sent` com a cobrança rascunhada (#4/AC-3): envia a cobrança, com `by` do Access; 200 { request }
// #36:           com followUp.sent (ou followUp.failure, o motivo curto, se o envio falhou: continua 200);
// #58:           a cobrança é devida a quem tem a leitura no_reply, ou partially_fulfilled / needs_information com nextStep follow_up (o pedido
// #58:           respondido pela metade, depois do prazo: a varredura monta a cobrança só dos itens que faltam, como a da PR #40);
// #36:           409 conflict { reason } no_draft | already_sent | send_in_progress; not_draft, da #13, quando a leitura não pede cobrança (recusa,
// #58:           atendido, resposta nossa a dar: answer_supplier / confirm_document / close); stale (#58/AC-5): o texto mudou entre a leitura e a
// #58:           reivindicação do envio (uma edição entrou no meio): nada saiu, releia o pedido e envie de novo, o texto novo;
// #36:           not_follow_up só numa corrida entre as duas leituras do pedido (a rota vê a leitura que pede cobrança e o caso de uso, já não);
// #36:           422 invalid { reason: 'text_invalid' }. Só esta rota envia a cobrança: nem o Cron nem as tarefas do Claude a enviam.
// #58:   PATCH /api/supplier-requests/{accessKey}/follow-up  { template }   200 { request }   troca só o corpo da cobrança (forma com {{chave}}) do pedido
// #58:           `sent` cuja leitura pede cobrança (no_reply, ou partially_fulfilled / needs_information com follow_up) e a cobrança rascunhada ainda não enviada; `by` é o e-mail do Access; o assunto, os itens e o novo prazo ficam.
// #58:           O texto é revalidado contra o catálogo da cobrança (o do pedido mais `cobranca.prazo`, o novo prazo): a resposta traz followUp.draft como no GET.
// #58:           422 invalid { reason: 'number_mismatch' | 'invalid_shape', field: 'body' } (número solto, marcador fora do catálogo, template que não é um texto
// #58:           não vazio de até 20.000 caracteres): o texto anterior fica. 409 conflict { reason }: already_sent (depois do envio a cobrança não se edita) |
// #58:           send_in_progress (o envio está reivindicado há menos que o prazo da reivindicação, LEASE_MS; vencida, a edição volta a valer e solta a reivindicação) |
// #58:           no_draft (o pedido não é `sent` com a leitura que pede cobrança, ou não tem rascunho) | stale (a linha mudou no meio; repita).
// #58:           404 not_found; 400, 401, 403, 415 e 502 como nas outras escritas. Editar nunca envia: só a rota send (POST) envia a cobrança.
// #63:   POST  /api/supplier-requests/{accessKey}/confirm-document  {}   200 { request }   a pessoa confirma o documento que o fornecedor citou na resposta
// #63:           (#4/AC-4): só do pedido `sent` cuja leitura é `fulfilled` com supplierDocument e nextStep `confirm_document`, ainda não confirmado. O corpo é
// #63:           ignorado (vazio ou {}): `by` é o e-mail do Access, nunca o corpo. Grava o documento, quem e quando (ADR-005) e nada mais: não envia nada ao
// #63:           fornecedor, não muda a leitura, a decisão, o título nem o valor em risco, e nenhuma varredura nem tarefa a chama (só esta rota). Confirmado,
// #63:           o pedido sai de needs_you e cai em answered (a lista e as contagens). 200 traz a visão `sent` com documentConfirmation.
// #63:           409 conflict { reason }: not_confirm_document (não é `sent`, sem leitura, ou a leitura não é o atendido com documento e confirm_document) |
// #63:           already_confirmed (o documento da leitura atual já foi confirmado; a primeira confirmação fica) | stale (a linha andou por outra gravação
// #63:           entre a leitura e a gravação: releia e repita). Duas chamadas ao mesmo tempo: uma 200 e a outra 409 already_confirmed.
// #63:           404 not_found; 400 invalid_access_key | invalid_json; 403 forbidden sem e-mail; 405 com Allow: POST; 415; 502 supabase_unavailable { correlationId }.
// #63:           Uma leitura nova com OUTRO documento deixa a confirmação velha para trás: o pedido volta a needs_you e pede outra; com o mesmo documento ela fica.
// #13:   POST  /api/supplier-requests/{accessKey}/resend   {}       200 { request }   só de send_failed; nunca emite outra nota
// #13:   POST  /api/supplier-requests/{accessKey}/discard  { reason?: string }   200 { request }   só de rascunho; reason aparado, até 500
// #13:           caracteres, padrão 'discarded_by_user'
// #13:   POST  /api/supplier-requests/{accessKey}/redo     {}       200 { request }   só quando o mais recente está descartado e não há aberto;
// #13:           faz o rascunho de novo pelo Claude
// #13:   GET   /api/supplier-requests/{accessKey}/return-note.json  200 a nota emitida no formato do kit; 404 antes da emissão (é o `url` do anexo)
// #57:   GET   /api/supplier-requests/{accessKey}/return-note.pdf  200 application/pdf, a mesma nota emitida desenhada em PDF (sem dependência, valores
// #57:           iguais aos do JSON); 404 { error: 'not_found' } antes da emissão. O envio (POST .../send e .../resend) leva o e-mail com DOIS anexos:
// #57:           `nota-devolucao-ND-n.json` (application/json) e `nota-devolucao-ND-n.pdf` (application/pdf); o reenvio leva os mesmos, sem emitir outra nota.
// #13:   GET   /api/supplier-requests?status=draft|sent|send_failed|discarded   200 { requests: SupplierRequestView[] }
// #13:           padrão draft; os 10 mais novos do estado; 400 { error: 'invalid_status' } fora dos quatro
// #36:   GET   /api/supplier-requests?status=awaiting|answered|needs_you|overdue   200 { filter, requests: ReadingRow[], counts }
// #36:           a lista da tela dos pedidos ao fornecedor (#5), pela leitura da resposta (#4): os filtros não colidem com os estados da #13.
// #36:           `counts` são os quatro filtros, contados sobre todos os pedidos enviados, com o dia de hoje em São Paulo; as linhas são só as do filtro,
// #36:           na ordem do id. 400 { error: 'invalid_status' } fora dos oito valores.
// #36:             awaiting   enviado, sem leitura, dentro do prazo (no dia do prazo ainda está no prazo)
// #36:             answered   fulfilled com next_step close
// #36:             needs_you  needs_information, refused, partially_fulfilled, ou next_step confirm_document (atendeu com documento citado nunca fecha sozinho)
// #36:             overdue    no_reply, ou enviado sem leitura depois do prazo
// #13:
// #36: ReadingRow (camelCase, como a SupplierRequestView):
// #36:   { id, invoiceAccessKey, invoiceNumber, supplierId, supplierName: string | null, requestType: 'return_note',
// #36:     totalCents (o total da nota de devolução, em centavos inteiros; a tela formata), dueOn ('AAAA-MM-DD'), status: 'sent',
// #36:     reading: Reading | null, followUp: { drafted: boolean, sent: boolean } }
// #36:   counts: { awaiting, answered, needs_you, overdue }, todos inteiros
// #36: Reading: { replyOutcome: 'fulfilled' | 'partially_fulfilled' | 'refused' | 'needs_information' | 'no_reply',
// #36:            fulfilledAsks: string[] (só itens do que pedimos), supplierDocument: string | null, summary, nextStep: 'close' | 'confirm_document' |
// #36:            'answer_supplier' | 'follow_up', injectionFlag: string | null (o trecho da resposta com ordem escondida, citado; dado, nunca instrução) }
// #36: a visão `sent` da SupplierRequestView (GET /{accessKey}, e o corpo do 200 das escritas) ganha, sem mudar nenhum campo da #13:
// #36:   reading: Reading | null, followUp: { drafted, sent, draft: { subject, body (renderizados), template (com {{chave}}), asks } | null,
// #36:                                          sentBy: string | null, sentAt: string | null, failure: string | null (código curto, nunca texto do provedor) }
// #58: followUp ganha dueOn: string | null, o novo prazo da cobrança ('AAAA-MM-DD'), o que a regra gravou com o rascunho (#59: a tela o mostra sem calcular
// #58: data); nulo sem rascunho, e no rascunho do Claude de antes da #58.
// #63: a visão `sent` ganha, sem mudar nenhum campo anterior, documentConfirmation: { document: string, by: string (o e-mail do Access), at: string (ISO 8601, UTC) } | null,
// #63:   a confirmação do documento citado na leitura atual (AC-3); null enquanto a pessoa não confirmou, e nunca ausente no pedido `sent`. Está na visão do GET
// #63:   /{accessKey}, na lista ?status=sent e no corpo do 200 das escritas; a linha da lista de leitura (ReadingRow) não a traz: o filtro `answered` já a diz.
// #36: "Cobrar" na tela abre followUp.draft para a pessoa revisar e enviar pelo POST .../send; o rascunho que já não confere com o catálogo vem null.
// #58: a cobrança é montada pela regra, sem o Claude, na varredura do prazo do Cron (api/src/cron/supplier-sweep.ts): pede só o que o fornecedor ainda não
// #58: atendeu, cita a nota de origem ({{nota.numero}}) e traz o novo prazo (3 dias úteis, {{cobranca.prazo}}); todo número é um marcador do catálogo.
// #58: followUp.draft.template guarda esse texto com {{chave}}; a pessoa o edita pelo PATCH .../follow-up antes de enviar.
// #36: a leitura e a cobrança só existem no pedido `sent`; nenhum outro estado as traz.
//
// #13: SupplierRequestView (alinhada à gaveta da web, fatia 3):
// #13:   { status: 'writing' }
// #13:   | { status: 'draft' | 'sent' | 'send_failed', invoiceAccessKey, requestType: 'return_note',
// #13:       returnNote: { number: string | null (o ND-n emitido; null antes da emissão), supplier (o código do fornecedor),
// #13:                     reference (o número da nota de origem), lines: [{ description, quantity ("40 UN"), unitPrice: { text }, total: { text } }],
// #13:                     total: { text } },
// #13:       email: { to, dueOn ('AAAA-MM-DD'), subject (renderizado), body (renderizado), template (com {{chave}}; é o que o PATCH envia) },
// #13:       asks: string[] (renderizado), attachment?: { name, url } (depois da emissão; #57: o PDF, `nota-devolucao-ND-n.pdf` e o `return-note.pdf`),
// #13:       sent: sentBy, sentAt (string | null só se a linha não tem o carimbo); send_failed: failure (código curto, nunca texto do provedor) }
// #13:   | { status: 'discarded', discardedAt, discardedBy }      descartado por uma pessoa
// #13:   | { status: 'failed', failure: 'number_mismatch' | 'invalid_shape' }   nasceu descartado pelo agente: o texto do Claude foi recusado (#2/AC-7)
// #13:   O dinheiro sai em texto pt-BR ("R$ 2.163,20"), feito no servidor a partir dos centavos.
// #13:
// #13: erros (sempre { error, ... }; o texto da dependência nunca sai, só vai ao log do Worker, com operação, tabela, status e correlationId):
// #13:   400 invalid_access_key (não são 44 dígitos) | invalid_status | invalid_json (corpo de escrita que não é um objeto JSON)
// #13:   401 sem o Access, pelo roteador | 403 forbidden (a identidade não tem e-mail, nas escritas)
// #13:   404 not_found | 405 method_not_allowed, com Allow | 415 unsupported_media_type (escrita sem Content-Type JSON, como em admin.ts)
// #13:   409 conflict { reason }: not_sendable | not_draft | not_send_failed | queue_not_pending | queue_entry_missing | issuance_missing |
// #13:       send_in_progress | stale | open_request_exists
// #63:       | not_confirm_document | already_confirmed (confirm-document)
// #13:   422 invalid { reason, field? }: number_mismatch | invalid_shape | source_missing | text_invalid | note_not_buildable
// #13:   502 supabase_unavailable { correlationId } | claude_unavailable { correlationId } (falha do Claude que não é de credencial)
// #13:   503 supabase_not_configured | claude_unavailable (sem credencial do Claude, ou 401 e 429 dele; só no redo)
// #13:   500 internal_error { correlationId }
// #13: quem age (`by`) é o e-mail da identidade do Access, nunca o corpo.
import { ClaudeClient, ClaudeError, credentialsFromEnv, type Ask } from '../claude/client.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import { owesFollowUp, type RequestFilter, type RequestStatus } from '../domain/index.js';
import type { Env } from '../env.js';
import { mailerFromEnv } from '../supplier/mock-mailer.js';
import { noteFilename, toKitNote } from '../supplier/kit-note.js';
import { returnNotePdf } from '../supplier/return-note-pdf.js';
import type { Clock, RequestRecord, SupplierDeps, SupplierMailer } from '../supplier/ports.js';
import { SupplierStoreError } from '../supplier/supabase-store.js';
import { supplierDeps } from '../supplier/supabase-deps.js';
import { createReplyUseCases, type ReplyUseCases } from '../supplier/reply-use-cases.js';
import { todayIso } from '../supplier/reply-catalog.js';
import type { ReplyDeps, ReplyRequest } from '../supplier/reply-ports.js';
import { replyDeps } from '../supplier/supabase-reply-deps.js';
import { createSupplierUseCases, type SupplierUseCases } from '../supplier/use-cases.js';
import type { Identity } from './access.js';
import { viewOf, type ViewResult, type WireRequest } from './supplier-request-view.js';
import { listOf } from './supplier-reply-view.js';

export interface SupplierRequestsDeps {
  /** #13: monta o cliente do Supabase a partir do Env; nulo sem credenciais. Os testes injetam um fake. */
  supabase?: (env: Env) => SupabaseRest | null;
  /** #13: o relógio; os testes fixam o dia do rascunho e do envio. */
  clock?: Clock;
  /** #13: o envio; padrão `mailerFromEnv(env)` (a caixa de saída mock sem chave do Resend). */
  mailer?: SupplierMailer;
  /** #13: a pergunta ao Claude do "refazer"; nulo sem credencial. Padrão: o cliente do Env. */
  ask?: (env: Env) => Ask | null;
}

const PATH = /^\/api\/supplier-requests(?:\/([^/]+)(?:\/(send|resend|discard|redo|follow-up|confirm-document|return-note\.json|return-note\.pdf))?)?$/;
const ACCESS_KEY = /^\d{44}$/;
const REQUEST_TYPE = 'return_note';
const MAX_REASON = 500;
const MAX_TEMPLATE = 20_000;
const DEFAULT_REASON = 'discarded_by_user';
/** #13: pedidos por lista; cada um custa leituras da nota de origem e da nota emitida, e o Worker limita as subrequests. */
const LIST_LIMIT = 10;
const STATUSES: readonly RequestStatus[] = ['draft', 'sent', 'send_failed', 'discarded']; // ADR-002
/** #36: os filtros da lista de leitura (#4); não colidem com os estados do pedido da #13. */
const FILTERS: readonly RequestFilter[] = ['awaiting', 'answered', 'needs_you', 'overdue']; // ADR-002

const ACTIONS = ['send', 'resend', 'discard', 'redo', 'follow-up', 'confirm-document', 'return-note.json', 'return-note.pdf'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (value: string | undefined): value is Action => (ACTIONS as readonly (string | undefined)[]).includes(value);
const isStatus = (value: string): value is RequestStatus => (STATUSES as readonly string[]).includes(value);
const isFilter = (value: string): value is RequestFilter => (FILTERS as readonly string[]).includes(value);
type Body = Record<string, unknown>;

const fail = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: HeadersInit): Response =>
  Response.json({ error, ...extra }, { status, headers });

const allowed = (key: string | undefined, action: Action | undefined): readonly string[] => {
  if (key === undefined) return ['GET'];
  if (action === undefined) return ['GET', 'PATCH'];
  if (action === 'return-note.json' || action === 'return-note.pdf') return ['GET'];
  return action === 'follow-up' ? ['PATCH'] : ['POST']; // #58
};

/** #13: o corpo de uma escrita; vazio vale {}, e o que não é um objeto JSON é nulo. */
async function bodyOf(request: Request): Promise<Body | null> {
  const text = await request.text();
  if (text.trim() === '') return {};
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Body) : null;
  } catch {
    return null;
  }
}

/** #13: tudo que uma operação precisa, montado uma vez por requisição. */
type Ctx = {
  readonly deps: SupplierDeps;
  readonly cases: SupplierUseCases;
  /** #36: as portas e os casos de uso da leitura da resposta (#4) e da cobrança. */
  readonly reply: ReplyDeps;
  readonly replyCases: ReplyUseCases;
  readonly env: Env;
  readonly routeDeps: SupplierRequestsDeps;
  readonly key: string;
  readonly by: string;
  readonly body: Body;
};

/** #13: o pedido da nota: o aberto, se houver; senão o mais recente. */
const currentOf = async (ctx: Ctx): Promise<RequestRecord | null> =>
  (await ctx.deps.requests.findOpen(ctx.key, REQUEST_TYPE)) ?? (await ctx.deps.requests.findLatest(ctx.key, REQUEST_TYPE));

/** #36: o pedido enviado leva a leitura e a cobrança; `replies` é o que a lista já leu de uma vez (2 leituras, não 2 por pedido). */
async function show(ctx: Ctx, record: RequestRecord, replies?: ReadonlyMap<number, ReplyRequest>): Promise<ViewResult> {
  const source = record.request.status === 'discarded' ? null : await ctx.deps.source.find(record.request.invoiceAccessKey); // ADR-002
  if (record.request.status !== 'sent') return viewOf(record, source); // ADR-002
  const reply = replies === undefined ? await ctx.reply.requests.get(record.request.id) : (replies.get(record.request.id) ?? null);
  return viewOf(record, source, reply);
}

const shown = (result: ViewResult): Response =>
  result.ok ? Response.json({ request: result.view }) : fail(422, 'invalid', { reason: result.reason });

/** #13: depois de gravar, relê o pedido para a visão trazer o carimbo de quem fez e quando. */
async function shownAfter(ctx: Ctx, id: number): Promise<Response> {
  const record = await ctx.deps.requests.get(id);
  return record === null ? fail(404, 'not_found') : shown(await show(ctx, record));
}

const conflict = (reason: string): Response => fail(409, 'conflict', { reason });

type Outcome = { readonly kind: string; readonly reason?: string; readonly field?: string };

/** #13: o que os casos de uso devolvem além do `ok` vira o status e o motivo da API. */
function refusal(outcome: Outcome): Response {
  if (outcome.kind === 'not_found') return fail(404, 'not_found');
  if (outcome.kind === 'conflict') return conflict(outcome.reason ?? 'stale');
  return fail(422, 'invalid', { reason: outcome.reason ?? 'invalid_shape', ...(outcome.field === undefined ? {} : { field: outcome.field }) });
}

/** #13/AC-1 (#2): sem pedido, a devolução pendente na fila é o "escrevendo" (o Cron ainda não fez o rascunho). */
async function read(ctx: Ctx): Promise<Response> {
  const record = await currentOf(ctx);
  if (record !== null) return shown(await show(ctx, record));
  const pending = (await ctx.deps.queue.list('pendente', ctx.deps.clock.now())).some((e) => e.invoiceAccessKey === ctx.key); // ADR-002
  const writing: WireRequest | null = pending ? { status: 'writing' } : null;
  return Response.json({ request: writing });
}

async function list(ctx: Ctx, status: RequestStatus): Promise<Response> {
  const records = await ctx.deps.requests.listByStatus(status, LIST_LIMIT);
  const replies = status === 'sent' ? new Map((await ctx.reply.requests.listSent()).map((r) => [r.id, r])) : undefined; // ADR-002
  const views: WireRequest[] = [];
  for (const record of records) {
    const result = await show(ctx, record, replies);
    if (result.ok) views.push(result.view);
    // #13: a visão que não se monta fica fora da lista, e o motivo vai ao log só em campos nomeados (nunca o texto do pedido).
    else console.error('supplier-requests: pedido fora da lista', { operation: 'supplier_requests.list', dropped: result.reason, invoiceAccessKey: record.request.invoiceAccessKey });
  }
  return Response.json({ requests: views });
}

/** #36/AC-2 (#4/AC-3): a lista de leitura da tela dos pedidos ao fornecedor: o filtro, os pedidos dele e as contagens de todos, com o dia de hoje em São Paulo. */
async function listReadings(ctx: Ctx, filter: RequestFilter): Promise<Response> {
  return Response.json(listOf(await ctx.replyCases.listRequests(filter, todayIso(ctx.reply.clock.now()))));
}

async function edit(ctx: Ctx): Promise<Response> {
  const template = ctx.body.template;
  if (typeof template !== 'string' || template.trim() === '' || template.length > MAX_TEMPLATE) {
    return fail(422, 'invalid', { reason: 'invalid_shape', field: 'body' });
  }
  const record = await currentOf(ctx);
  if (record === null) return fail(404, 'not_found');
  const result = await ctx.cases.editBody(record.request.id, template, ctx.by);
  return result.kind === 'ok' ? shownAfter(ctx, record.request.id) : refusal(result);
}

/**
 * #58/AC-4, AC-5: troca o texto (o corpo, na forma com {{chave}}) da cobrança ainda não enviada. O texto é revalidado contra o catálogo da
 * cobrança (o do pedido e o novo prazo) e o anterior fica quando recusado; depois do envio não se edita (409). Só edita: o envio é da rota `send` (#58/AC-7).
 */
async function editFollowUp(ctx: Ctx): Promise<Response> {
  const template = ctx.body.template;
  if (typeof template !== 'string' || template.trim() === '' || template.length > MAX_TEMPLATE) {
    return fail(422, 'invalid', { reason: 'invalid_shape', field: 'body' });
  }
  const record = await currentOf(ctx);
  if (record === null) return fail(404, 'not_found');
  const result = await ctx.replyCases.editFollowUp(record.request.id, template, ctx.by);
  return result.kind === 'ok' ? shownAfter(ctx, record.request.id) : refusal(result);
}

/**
 * #36/AC-3 (#4/AC-3): o pedido enviado com a leitura no_reply tem a cobrança a enviar: a rota de envio a manda pelo caso de uso
 * da cobrança, com a identidade do Access. Os resultados tipados viram HTTP como os da #13; a falha do envio é um estado (200).
 */
async function sendFollowUp(ctx: Ctx, id: number): Promise<Response> {
  const result = await ctx.replyCases.sendFollowUp(id, ctx.by);
  return result.kind === 'ok' || result.kind === 'send_failed' ? shownAfter(ctx, id) : refusal(result); // ADR-002
}

/**
 * #63/AC-1, AC-4, AC-6: a pessoa confirma o documento que o fornecedor citou na resposta; `by` vem do Access, nunca do corpo. Só grava a confirmação:
 * nada é enviado ao fornecedor (#63/AC-5). Os resultados tipados viram HTTP como os das outras escritas.
 */
async function confirmDocument(ctx: Ctx): Promise<Response> {
  const record = await currentOf(ctx);
  if (record === null) return fail(404, 'not_found');
  const result = await ctx.replyCases.confirmDocument(record.request.id, ctx.by);
  return result.kind === 'ok' ? shownAfter(ctx, record.request.id) : refusal(result);
}

/** #13: o envio exige o estado de partida da rota (rascunho no `send`, falha no `resend`), e só depois chama o caso de uso. */
async function send(ctx: Ctx, from: RequestStatus, reason: string): Promise<Response> {
  const record = await currentOf(ctx);
  if (record === null) return fail(404, 'not_found');
  if (from === 'draft' && record.request.status === 'sent') { // ADR-002
    const reply = await ctx.reply.requests.get(record.request.id);
    if (reply !== null && owesFollowUp(reply.reading)) return sendFollowUp(ctx, record.request.id); // #58/AC-2: no_reply, ou a resposta parcial / pedido de informação com follow_up
  }
  if (record.request.status !== from) return conflict(reason);
  const result = await ctx.cases.send(record.request.id, ctx.by);
  return result.kind === 'ok' || result.kind === 'send_failed' ? shownAfter(ctx, record.request.id) : refusal(result); // ADR-002
}

async function discard(ctx: Ctx): Promise<Response> {
  const asked = ctx.body.reason;
  if (asked !== undefined && typeof asked !== 'string') return fail(422, 'invalid', { reason: 'invalid_shape', field: 'reason' });
  const reason = (asked ?? '').trim().slice(0, MAX_REASON);
  const record = await currentOf(ctx);
  if (record === null) return fail(404, 'not_found');
  const result = await ctx.cases.discard(record.request.id, ctx.by, reason === '' ? DEFAULT_REASON : reason);
  return result.kind === 'ok' ? shownAfter(ctx, record.request.id) : refusal(result);
}

/** #13: o `Ask` do "refazer": o injetado, ou o cliente do Claude do Env; sem credencial, nulo. */
function askFor(ctx: Ctx): Ask | null {
  if (ctx.routeDeps.ask !== undefined) return ctx.routeDeps.ask(ctx.env);
  const credentials = credentialsFromEnv(ctx.env);
  return credentials === undefined ? null : new ClaudeClient({ credentials }).ask;
}

async function redo(ctx: Ctx): Promise<Response> {
  const latest = await currentOf(ctx);
  if (latest === null) return fail(404, 'not_found');
  if (latest.request.isOpen) return conflict('open_request_exists');
  const ask = askFor(ctx);
  if (ask === null) return fail(503, 'claude_unavailable');
  const result = await ctx.cases.redraft(latest.request.id, ask);
  return result.kind === 'ok' ? shown(await show(ctx, result.record)) : refusal(result);
}

async function returnNoteJson(ctx: Ctx): Promise<Response> {
  const issued = (await currentOf(ctx))?.request.issuedNote ?? null;
  return issued === null ? fail(404, 'not_found') : Response.json(toKitNote(issued));
}

/** #57/AC-2: o PDF da mesma nota emitida; 404 antes da emissão, como o JSON. Só a nota sai, sem campo de erro nem de dependência. */
async function returnNotePdfResponse(ctx: Ctx): Promise<Response> {
  const issued = (await currentOf(ctx))?.request.issuedNote ?? null;
  if (issued === null) return fail(404, 'not_found');
  return new Response(returnNotePdf(toKitNote(issued)), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${noteFilename(issued, 'pdf')}"`, 'Cache-Control': 'private, no-store' },
  });
}

async function runAction(ctx: Ctx, action: Action | undefined, method: string): Promise<Response> {
  switch (action) {
    case undefined:
      return method === 'PATCH' ? edit(ctx) : read(ctx);
    case 'send':
      return send(ctx, 'draft', 'not_draft'); // ADR-002
    case 'resend':
      return send(ctx, 'send_failed', 'not_send_failed'); // ADR-002
    case 'discard':
      return discard(ctx);
    case 'redo':
      return redo(ctx);
    case 'follow-up':
      return editFollowUp(ctx);
    case 'confirm-document':
      return confirmDocument(ctx);
    case 'return-note.json':
      return returnNoteJson(ctx);
    case 'return-note.pdf':
      return returnNotePdfResponse(ctx);
  }
}

/** #13: a falha vira resposta genérica com o correlationId; o detalhe vai ao log só como campos nomeados. */
function failureResponse(error: unknown, operation: string): Response {
  const correlationId = crypto.randomUUID();
  if (error instanceof SupabaseRestError || error instanceof SupplierStoreError) {
    console.error('supplier-requests: falha do Supabase', { operation, table: error.table, status: error.status, correlationId });
    return fail(502, 'supabase_unavailable', { correlationId });
  }
  if (error instanceof ClaudeError) {
    console.error('supplier-requests: falha do Claude', { operation, kind: error.kind, status: error.status, correlationId });
    return error.isGlobal ? fail(503, 'claude_unavailable') : fail(502, 'claude_unavailable', { correlationId });
  }
  console.error('supplier-requests: falha inesperada', { operation, errorName: error instanceof Error ? error.name : 'Error', correlationId });
  return fail(500, 'internal_error', { correlationId });
}

const contextOf = (rest: SupabaseRest, env: Env, routeDeps: SupplierRequestsDeps, key: string, by: string, body: Body): Ctx => {
  const deps = supplierDeps(rest, { ...(routeDeps.clock ? { clock: routeDeps.clock } : {}), mailer: routeDeps.mailer ?? mailerFromEnv(env) });
  const reply = replyDeps(rest, { ...(routeDeps.clock ? { clock: routeDeps.clock } : {}), mailer: deps.mailer });
  return { deps, cases: createSupplierUseCases(deps), reply, replyCases: createReplyUseCases(reply), env, routeDeps, key, by, body };
};

/** #13: a lista tem a sua rota, sem chave: valida o estado ou o filtro pedido e responde. */
async function listRoute(request: Request, rest: SupabaseRest, env: Env, routeDeps: SupplierRequestsDeps): Promise<Response> {
  const status = new URL(request.url).searchParams.get('status') ?? 'draft'; // ADR-002
  if (!isStatus(status) && !isFilter(status)) return fail(400, 'invalid_status');
  try {
    const ctx = contextOf(rest, env, routeDeps, '', '', {});
    return await (isFilter(status) ? listReadings(ctx, status) : list(ctx, status));
  } catch (error) {
    return failureResponse(error, 'list');
  }
}

/** #13: devolve nulo quando o caminho não é desta API, para o roteador seguir. */
export async function supplierRequestRoutes(
  request: Request,
  identity: Identity,
  env: Env,
  routeDeps: SupplierRequestsDeps,
  fallbackSupabase: (env: Env) => SupabaseRest | null,
): Promise<Response | null> {
  const match = PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  const [, key, rawAction] = match;
  const action = isAction(rawAction) ? rawAction : undefined;

  const methods = allowed(key, action);
  if (!methods.includes(request.method)) return fail(405, 'method_not_allowed', {}, { Allow: methods.join(', ') });
  if (key !== undefined && !ACCESS_KEY.test(key)) return fail(400, 'invalid_access_key');

  const writing = request.method !== 'GET';
  if (writing && !identity.email) return fail(403, 'forbidden');
  // #13: muda estado e o Access também aceita o cookie: só JSON, que força o preflight de CORS que o Worker não responde (como em admin.ts).
  if (writing && !request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return fail(415, 'unsupported_media_type');
  }
  const body = writing ? await bodyOf(request) : {};
  if (body === null) return fail(400, 'invalid_json');

  const rest = (routeDeps.supabase ?? fallbackSupabase)(env);
  if (!rest) return fail(503, 'supabase_not_configured');
  if (key === undefined) return listRoute(request, rest, env, routeDeps);

  try {
    return await runAction(contextOf(rest, env, routeDeps, key, identity.email ?? '', body), action, request.method);
  } catch (error) {
    return failureResponse(error, action ?? request.method.toLowerCase());
  }
}
