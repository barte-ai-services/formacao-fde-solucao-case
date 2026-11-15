// #63 API da fila de aprovação, da proposta, de aprovar e alterar, e da lista do dia.
import { exceptionFields } from '../domain/exception-catalog.js';
import { approverDirectory, type ApproverDirectory } from '../approval/approvers.js';
import { AlreadyDecidedError, type ApprovalStore, type CaseFile, type StoredAudit } from '../approval/store.js';
import { approve, isEngineApproval, NotAllowedToApproveError, type Approval, type Decision } from '../domain/approval.js';
import { ApprovalPolicy, type PersonLevel } from '../domain/approval-policy.js';
import { DockAction, type PartialLine } from '../domain/dock-action.js';
import { DomainError, InvalidTransitionError } from '../domain/errors.js';
import { Money } from '../domain/money.js';
import { Quantity, type Unit } from '../domain/quantity.js';
import type { Env } from '../env.js';
import type { Identity } from './access.js';
import type { CheckContext, Invoice, Product } from '../domain/index.js';
import type { AuditedField } from '../domain/invoice-audit.js';
import {
  dossierField,
  dossierGenerating,
  dossierReadFailed,
  type ProposalDossierField,
} from '../dossier/proposal-field.js';
import { generateOnDemand, type OnDemandDeps } from '../dossier/on-demand.js';
import {
  inFlight,
  triggerOf,
  LIMIT_WINDOW_MS,
  MAX_REQUESTS_PER_WINDOW,
  IN_FLIGHT_MS,
  type DossierRequests,
} from '../dossier/requests.js';
import { needsDossier } from '../claude/tasks/dossier.js';
import { readDossier } from '../dossier/read-dossier.js';
import { ACCESS_KEY, type DossierSource } from '../dossier/source.js';
import type { DockActionOutbox, StoreActionOutbox } from '../connectors/ports.js';
import { SupabaseRestError } from '../connectors/supabase-rest.js';
import { publishApprovedDockAction } from '../dock/publish-approved-dock-action.js';
import { publishApprovedStoreAction } from '../dock/publish-approved-store-action.js';
import { buildTimeline } from '../automation/timeline.js';
import type { TimelineSource } from '../automation/readers.js';
import { receivingPlace } from '../dock/receiving-place.js';
import { engineView, type EngineView } from '../engine/agreement.js';
import type { EngineReader } from '../engine/store.js';

export interface ApprovalDeps {
  store: ApprovalStore;
  /** O dia de hoje em Brasília (AAAA-MM-DD). Injetável para os testes. */
  today?: () => string;
  /** #68: de onde a proposta lê o dossiê do Claude. Sem ele, o dossiê aparece pendente. */
  dossier?: DossierDeps;
  /** #176 Os produtos do cadastro, para mostrar a quantidade em unidade de estoque (fator de caixa). Sem ele, vai nula. */
  products?: (invoiceAccessKey: string) => Promise<readonly Product[]>;
  /**
   * #43 AC-1: a caixa de saída do WMS. Aprovar ou alterar publica nela a ação na doca, depois de gravar
   * a decisão. Sem ela, a decisão fica só gravada e a varredura do Cron publica depois.
   */
  dockOutbox?: DockActionOutbox;
  /** #135 A caixa de saída do app da loja: a ação da nota de loja (`LJ-*`) vai para ela, não para o WMS. */
  storeOutbox?: StoreActionOutbox;
  /** #211 Os horários da linha do tempo da nota. Sem ele, `timeline` vai vazia. */
  timeline?: TimelineSource;
  /** #41 AC-4 As decisões do motor da nota. Sem ele, `engine` vai nulo. */
  engine?: Pick<EngineReader, 'forProposal'>;
}

/** #68: a fonte do dossiê e o contexto da nota, para conferir os números contra o banco. */
export interface DossierDeps {
  source: DossierSource;
  context: (invoiceAccessKey: string) => Promise<CheckContext>;
  /** #130 Os pedidos da gaveta. Sem ele, o pedido responde 503 e o GET não mostra `generating`. */
  requests?: DossierRequests;
  /** #130 O que a geração sob demanda usa além dos pedidos e do contexto: o banco e o Claude. */
  onDemand?: Omit<OnDemandDeps, 'requests' | 'context' | 'now'>;
  /** #130 Relógio das janelas de 5 min e de 1 h. */
  now?: () => Date;
}

/** #130 Agenda o trabalho que segue depois da resposta (o waitUntil do Worker). */
export type Defer = (work: Promise<unknown>) => void;

const PROPOSAL_PATH = /^\/api\/propostas\/([^/]+)(?:\/(aprovar|alterar|dossie))?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** O dia de hoje no fuso de Brasília, onde a Já Chegou paga. */
export function todayInBrasilia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
}

/**
 * #63 Atende as rotas da aprovação. Devolve nulo quando o caminho não é dela, para o roteador
 * seguir. Só roda depois do Access (a identidade já foi conferida).
 */
export async function approvalRoutes(
  request: Request,
  identity: Identity,
  env: Env,
  deps: ApprovalDeps,
  defer: Defer = (work) => void work,
): Promise<Response | null> {
  const { pathname, searchParams } = new URL(request.url);
  const directory = approverDirectory(env.APPROVER_LEVELS);
  const today = deps.today ?? (() => todayInBrasilia());

  if (pathname === '/api/fila') {
    return only(request, 'GET', () => queue(deps.store, identity, directory));
  }
  if (pathname === '/api/hoje') {
    const day = searchParams.get('dia') ?? today();
    if (!DAY.test(day)) return error(400, 'dia_invalido');
    return only(request, 'GET', () => todayList(deps.store, day));
  }
  const match = PROPOSAL_PATH.exec(pathname);
  if (!match) return null;
  let key: string;
  try {
    key = decodeURIComponent(match[1] ?? '');
  } catch {
    return error(400, 'chave_invalida');
  }
  const action = match[2];
  if (action === 'dossie') return only(request, 'POST', () => requestDossier(deps, key, identity, defer));
  if (!action) {
    return only(request, 'GET', () =>
      proposalDetail(deps.store, key, identity, directory, deps.dossier, deps.products, deps.timeline, deps.engine),
    );
  }
  return only(request, 'POST', () => decide(request, deps, key, action, identity, directory, today()));
}

async function only(request: Request, method: string, run: () => Promise<Response>): Promise<Response> {
  if (request.method !== method) {
    return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { Allow: method } });
  }
  return run();
}

function error(status: number, code: string, message?: string): Response {
  return Response.json(message ? { error: code, message } : { error: code }, { status });
}

const money = (m: Money) => ({ cents: m.cents, text: m.toString() });

function summary(file: CaseFile, level: PersonLevel | null) {
  const { invoice, proposal, route } = file;
  return {
    invoiceAccessKey: invoice.accessKey,
    number: invoice.number,
    supplierId: invoice.supplierId,
    store: invoice.store,
    issuedOn: invoice.issuedOn,
    total: money(invoice.total),
    classification: proposal.classification,
    ...exceptionFields(proposal.classification),
    level: proposal.level,
    line: route.line,
    reason: route.reason,
    requiredApproverLevel: ApprovalPolicy.requiredApproverLevel(proposal.level),
    amountAtRisk: money(proposal.amountAtRisk.amount),
    dockAction: proposal.dockAction,
    state: proposal.state,
    canApprove: proposal.state === 'aguardando_aprovacao' && ApprovalPolicy.canApprove(level, proposal.level),
  };
}

/** AC-6: quem aprova encontra a proposta na fila; `canApprove` diz se é do nível dela. */
async function queue(store: ApprovalStore, identity: Identity, directory: ApproverDirectory): Promise<Response> {
  const level = directory(identity.email);
  const files = await store.listAwaiting();
  return Response.json({
    approver: { email: identity.email, level },
    items: files.map((f) => summary(f, level)),
  });
}

/** AC-12: a proposta mostra a evidência de cada divergência e o valor em risco. */
async function proposalDetail(
  store: ApprovalStore,
  key: string,
  identity: Identity,
  directory: ApproverDirectory,
  dossier?: DossierDeps,
  products?: ApprovalDeps['products'],
  timeline?: TimelineSource,
  engine?: ApprovalDeps['engine'],
): Promise<Response> {
  const file = await store.find(key);
  if (!file) return error(404, 'not_found');
  const catalog = await readProducts(key, products);
  const dossierView = await proposalDossier(key, file, dossier);
  return Response.json({
    ...summary(file, directory(identity.email)),
    justification: file.proposal.justification,
    items: file.invoice.items.map((i) => ({
      supplierCode: i.supplierCode,
      sku: i.sku,
      description: i.description,
      quantity: { amount: i.quantity.amount, unit: i.quantity.unit },
      stockQuantity: stockQuantity(i, file.invoice.supplierId, catalog),
      unitPrice: money(i.unitPrice),
      total: money(i.total),
    })),
    divergences: file.invoice.divergences.map((d) => ({
      classification: d.classification,
      ...exceptionFields(d.classification),
      skus: d.skus,
      evidence: d.evidence,
    })),
    title: { state: file.title.state, amount: money(file.title.amount), dueOn: file.title.dueOn },
    approval: file.approval,
    dossier: dossierView,
    timeline: await proposalTimeline(key, file, timeline),
    engine: await proposalEngine(key, file, engine),
    audit: auditView(file.audit ?? null),
  });
}

/**
 * #41 AC-4 O motor ao lado da pessoa: a decisão da cascata em modo sombra, a medição do Clef e, quando a pessoa
 * já decidiu, se concordou. Sem decisão do motor, nulo; um erro ao ler também, sem derrubar a proposta.
 * #42 AC-2 A decisão do modo delegado vem primeiro, quando existe: é ela que leva a proposta à pessoa com a
 * recomendação do motor e o porquê (`below_confidence`). Sem ela, a do modo sombra, como antes.
 */
async function proposalEngine(key: string, file: CaseFile, engine?: ApprovalDeps['engine']): Promise<EngineView | null> {
  if (!engine) return null;
  try {
    const delegated = engineView(await engine.forProposal(key, 'delegated'), file.proposal.state);
    if (delegated) return delegated;
    return engineView(await engine.forProposal(key, 'shadow'), file.proposal.state);
  } catch (e) {
    console.error(`#41 motor da nota ${key} não lido: ${e instanceof Error ? e.name : 'erro'}`);
    return null;
  }
}

/** #230 Na resposta, o campo que difere usa o camelCase das demais chaves; no banco e no domínio segue em snake_case. */
const responseField = (field: AuditedField): string => (field === 'dock_action' ? 'dockAction' : field);

/** #230 AC-7 A auditoria da nota na resposta: null (pendente), "não auditada" com o motivo, ou a auditada com a concordância. */
function auditView(audit: StoredAudit | null) {
  if (audit === null) return null;
  if (audit.status === 'nao_auditada') return { status: audit.status, reason: audit.reason, refusals: audit.refusals };
  return {
    status: audit.status,
    classification: audit.classification,
    dockAction: { kind: audit.dockAction },
    routing: audit.routing,
    justification: audit.justification,
    amountAtRisk: audit.amountAtRiskCents === null ? null : money(Money.ofCents(audit.amountAtRiskCents)),
    model: audit.model,
    auditedAt: audit.auditedAt,
    agreement: audit.differs.length === 0 ? { agrees: true } : { agrees: false, differs: audit.differs.map(responseField) },
    raisedLevel: audit.raisedLevel,
    injectionFlag: audit.injectionFlag,
    refusals: audit.refusals,
  };
}

/** #211 AC-4 Um erro ao ler os horários não derruba a proposta: a linha do tempo vai vazia. */
async function proposalTimeline(key: string, file: CaseFile, source?: TimelineSource) {
  if (!source) return [];
  try {
    return buildTimeline(
      {
        classification: file.proposal.classification,
        level: file.proposal.level,
        line: file.route.line,
        state: file.proposal.state,
        approval: file.approval,
      },
      await source.find(key),
    );
  } catch (e) {
    console.error(`#211 linha do tempo da nota ${key} não lida: ${e instanceof Error ? e.name : 'erro'}`);
    return [];
  }
}

/** #176 Um erro ao ler o cadastro não derruba a proposta: a unidade de estoque vai nula. */
async function readProducts(key: string, products?: ApprovalDeps['products']): Promise<readonly Product[]> {
  if (!products) return [];
  try {
    return await products(key);
  } catch (e) {
    console.error(`#176 cadastro da nota ${key} não lido: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** #176 Regra 4: a quantidade do item em UN pelo fator de caixa do cadastro; nula se o produto não é achado. */
function stockQuantity(
  item: Invoice['items'][number],
  supplierId: string,
  catalog: readonly Product[],
): { amount: number; unit: Unit } | null {
  const product = catalog.find((p) => p.sku === item.sku || (p.supplierId === supplierId && p.supplierCode === item.supplierCode));
  if (!product) return null;
  try {
    const units = item.quantity.toUnits(product.boxFactor);
    return { amount: units.amount, unit: units.unit };
  } catch {
    return null; // #176 fator inválido no cadastro: a gaveta mostra só a unidade da nota
  }
}

/**
 * #68: o dossiê é conferido contra o banco na hora de mostrar; sem fonte, fica pendente. Um erro ao
 * ler não derruba a proposta (#38/AC-4): vira `read_failed` e fica no log só com a chave e a mensagem.
 * O contexto da nota só é carregado quando há sugestão `ok`; sem linha, fica `pending` sem lê-lo.
 */
async function proposalDossier(key: string, file: CaseFile, dossier?: DossierDeps): Promise<ProposalDossierField> {
  if (!dossier) return dossierField(null);
  const generating = await openRequest(key, dossier);
  if (generating) return dossierGenerating(generating.requested_by, generating.requested_at, triggerOf(generating));
  try {
    return dossierField(
      await readDossier({
        invoiceAccessKey: key,
        invoice: file.invoice,
        loadContext: () => dossier.context(key),
        source: dossier.source,
      }),
    );
  } catch (e) {
    console.error(`#68 dossiê da nota ${key} não lido: ${e instanceof Error ? e.message : String(e)}`);
    return dossierReadFailed();
  }
}

/** #130 O pedido da gaveta em andamento. Um erro ao ler os pedidos não derruba a proposta: segue sem ele. */
async function openRequest(key: string, dossier: DossierDeps) {
  if (!dossier.requests || !ACCESS_KEY.test(key)) return undefined;
  const now = (dossier.now ?? (() => new Date()))();
  try {
    return inFlight(await dossier.requests.since(key, new Date(now.getTime() - IN_FLIGHT_MS)), now);
  } catch (e) {
    console.error(`#130 pedidos do dossiê da nota ${key} não lidos: ${e instanceof Error ? e.name : 'erro'}`);
    return undefined;
  }
}

/**
 * #130 AC-2 e AC-6: a pessoa pede o dossiê na gaveta. 202 e a geração segue depois da resposta; 409 com uma
 * geração em andamento; 429 com MAX_REQUESTS_PER_WINDOW pedidos na última hora. O token do Claude fica no Worker
 * (AC-7): a resposta leva só o estado do pedido.
 */
async function requestDossier(deps: ApprovalDeps, key: string, identity: Identity, defer: Defer): Promise<Response> {
  if (!ACCESS_KEY.test(key)) return error(400, 'chave_invalida');
  const dossier = deps.dossier;
  if (!dossier?.requests || !dossier.onDemand) return error(503, 'indisponivel', 'O dossiê sob demanda não está ligado');
  if (!identity.email) return error(403, 'sem_email', 'O Access não informou o e-mail de quem pede');
  const file = await deps.store.find(key);
  if (!file || !needsDossier(file)) return error(404, 'not_found');
  const now = (dossier.now ?? (() => new Date()))();
  const recent = await dossier.requests.since(key, new Date(now.getTime() - LIMIT_WINDOW_MS));
  if (inFlight(recent, now)) return error(409, 'em_andamento', 'O Claude já está escrevendo este dossiê');
  // #130 #38 O limite é dos pedidos da pessoa: a linha do evento não conta.
  if (recent.filter((r) => triggerOf(r) === 'on_demand').length >= MAX_REQUESTS_PER_WINDOW) {
    return error(429, 'limite', 'Muitos pedidos para esta proposta. Tente de novo em alguns minutos.');
  }
  const requestedAt = now.toISOString();
  const requestId = await dossier.requests.open({ input_key: key, requested_by: identity.email, requested_at: requestedAt });
  defer(
    generateOnDemand(
      { ...dossier.onDemand, requests: dossier.requests, context: dossier.context, now: dossier.now },
      { invoiceAccessKey: key, invoice: file.invoice, requestedBy: identity.email, requestedAt, requestId },
    ),
  );
  return Response.json(
    { status: 'generating', trigger: 'on_demand', requested_by: identity.email, requested_at: requestedAt },
    { status: 202 },
  );
}

/** AC-7 a AC-11: aprovar ou alterar, com o nível de quem passou pelo Access. */
async function decide(
  request: Request,
  deps: ApprovalDeps,
  key: string,
  action: string,
  identity: Identity,
  directory: ApproverDirectory,
  today: string,
): Promise<Response> {
  const level = directory(identity.email);
  if (!identity.email || !level) return error(403, 'sem_nivel', 'Seu e-mail não tem nível de aprovação');

  let decision: Decision;
  if (action === 'aprovar') {
    decision = { kind: 'aprovar' };
  } else {
    const parsed = await parseAlteration(request);
    if ('error' in parsed) return error(422, 'alteracao_invalida', parsed.error);
    decision = parsed.decision;
  }

  const { store } = deps;
  const file = await store.find(key);
  if (!file) return error(404, 'not_found');
  try {
    const approval = approve(file.invoice, file.proposal, file.title, { email: identity.email, level }, decision, today, {
      paymentBlocked: file.supplierBlocked,
    });
    await store.saveDecision({ ...file, approval });
    await publishDecision(deps, key, file);
    return Response.json({ approval, title: { state: file.title.state, amount: money(file.title.amount) } });
  } catch (e) {
    if (e instanceof NotAllowedToApproveError) return error(403, 'nivel_insuficiente', e.message);
    if (e instanceof InvalidTransitionError || e instanceof AlreadyDecidedError) {
      return error(409, 'ja_decidida', 'A proposta já foi decidida');
    }
    if (e instanceof DomainError) return error(422, 'decisao_invalida', e.message);
    throw e;
  }
}

/**
 * #43 AC-1: a decisão gravada chega à doca pela caixa de saída do WMS, idempotente. Se o WMS falha, a
 * decisão continua valendo (já está gravada): o log leva só a chave e o status HTTP, e a varredura do Cron
 * (`publishDecidedDockActions`) publica na próxima rodada.
 */
async function publishDecision(deps: ApprovalDeps, key: string, file: CaseFile): Promise<void> {
  const event = { type: 'proposta_aprovada', invoiceAccessKey: key, proposal: file.proposal } as const;
  try {
    // #135 O lugar sai do destino: loja no app da loja, CD no WMS.
    if (receivingPlace(file.invoice.store) === 'app_loja') {
      if (deps.storeOutbox) await publishApprovedStoreAction(event, file.invoice.store, deps.storeOutbox);
    } else if (deps.dockOutbox) {
      await publishApprovedDockAction(event, deps.dockOutbox);
    }
  } catch (e) {
    // #43 Só campos nomeados no log: a mensagem do erro pode trazer o corpo da resposta do PostgREST.
    const status = e instanceof SupabaseRestError ? ` (HTTP ${e.status})` : '';
    console.error(`#43 ação na doca da nota ${key} não publicada agora${status}; a varredura do Cron publica depois`);
  }
}

type Parsed = { decision: Decision } | { error: string };

/** Regra 8: alterar traz a nova ação na doca e a justificativa. */
async function parseAlteration(request: Request): Promise<Parsed> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { error: 'O corpo precisa ser JSON' };
  }
  if (!body || typeof body !== 'object') return { error: 'O corpo precisa ser um objeto' };
  const { dockAction, justification } = body as { dockAction?: unknown; justification?: unknown };
  if (typeof justification !== 'string' || justification.trim() === '') {
    return { error: 'Alterar exige justificativa' };
  }
  try {
    return { decision: { kind: 'alterar', dockAction: parseDockAction(dockAction), justification } };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Ação na doca inválida' };
  }
}

function parseDockAction(raw: unknown): DockAction {
  const kind = raw && typeof raw === 'object' ? (raw as { kind?: unknown }).kind : undefined;
  if (kind === 'receber') return DockAction.receive();
  if (kind === 'recusar') return DockAction.refuse();
  if (kind === 'receber_parcial') {
    const lines = (raw as { lines?: unknown }).lines;
    if (!Array.isArray(lines)) throw new DomainError('Receber parcial exige as linhas');
    return DockAction.partial(lines.map(parsePartialLine));
  }
  throw new DomainError('Ação na doca deve ser receber, receber_parcial ou recusar');
}

function parsePartialLine(raw: unknown): PartialLine {
  const l = (raw ?? {}) as { sku?: unknown; quantity?: { amount?: unknown; unit?: unknown }; disposition?: unknown };
  const unit = l.quantity?.unit;
  if (typeof l.sku !== 'string' || typeof l.quantity?.amount !== 'number' || (unit !== 'UN' && unit !== 'CX')) {
    throw new DomainError('Cada linha traz sku e quantidade em UN ou CX');
  }
  if (l.disposition !== 'segurar' && l.disposition !== 'devolver') {
    throw new DomainError('Cada linha diz se segura ou devolve');
  }
  return { sku: l.sku, quantity: Quantity.of(l.quantity.amount, unit as Unit), disposition: l.disposition };
}

/** #42 AC-4 Quem aprovou, no vocabulário de `approvals.approved_by`. */
function approvedByOf(approval: Approval | null): 'rule' | 'engine' | 'person' | null {
  if (!approval) return null;
  if (approval.approverLevel === 'regra') return 'rule';
  return isEngineApproval(approval) ? 'engine' : 'person';
}

/** AC-13: os títulos liberados ou reduzidos no dia; nenhum bloqueado e nenhum de nota sem decisão. */
async function todayList(store: ApprovalStore, day: string): Promise<Response> {
  const files = await store.listDecidedOn(day);
  const scheduled = files.filter((f) => f.title.state === 'na_lista_do_dia');
  const items = scheduled.map((f) => ({
    invoiceAccessKey: f.invoice.accessKey,
    number: f.invoice.number,
    supplierId: f.invoice.supplierId,
    amount: money(f.title.amount),
    invoiceTotal: money(f.invoice.total),
    dueOn: f.title.dueOn,
    ...exceptionFields(f.proposal.classification),
    dockAction: f.proposal.dockAction.kind,
    approver: f.approval?.approver ?? null,
    // #42 AC-4 Quem aprovou, como a coluna gerada `approvals.approved_by`: a régua, o motor ("Aprovado pelo motor")
    // ou a pessoa.
    approvedBy: approvedByOf(f.approval),
  }));
  const total = scheduled.reduce((sum, f) => sum + f.title.amount.cents, 0);
  return Response.json({ day, items, total: { cents: total } });
}
