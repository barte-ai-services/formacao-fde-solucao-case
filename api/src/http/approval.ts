// #63 API da fila de aprovação, da proposta, de aprovar e alterar, e da lista do dia.
import { approverDirectory, type ApproverDirectory } from '../approval/approvers.js';
import { AlreadyDecidedError, type ApprovalStore, type CaseFile } from '../approval/store.js';
import { approve, NotAllowedToApproveError, type Decision } from '../domain/approval.js';
import { ApprovalPolicy, type PersonLevel } from '../domain/approval-policy.js';
import { DockAction, type PartialLine } from '../domain/dock-action.js';
import { DomainError, InvalidTransitionError } from '../domain/errors.js';
import type { Money } from '../domain/money.js';
import { Quantity, type Unit } from '../domain/quantity.js';
import type { Env } from '../env.js';
import type { Identity } from './access.js';
import type { CheckContext } from '../domain/index.js';
import { dossierField, dossierReadFailed, type DossierField } from '../dossier/proposal-field.js';
import { readDossier } from '../dossier/read-dossier.js';
import type { DossierSource } from '../dossier/source.js';

export interface ApprovalDeps {
  store: ApprovalStore;
  /** O dia de hoje em Brasília (AAAA-MM-DD). Injetável para os testes. */
  today?: () => string;
  /** #68: de onde a proposta lê o dossiê do Claude. Sem ele, o dossiê aparece pendente. */
  dossier?: DossierDeps;
}

/** #68: a fonte do dossiê e o contexto da nota, para conferir os números contra o banco. */
export interface DossierDeps {
  source: DossierSource;
  context: (invoiceAccessKey: string) => Promise<CheckContext>;
}

const PROPOSAL_PATH = /^\/api\/propostas\/([^/]+)(?:\/(aprovar|alterar))?$/;
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
  if (!action) return only(request, 'GET', () => proposalDetail(deps.store, key, identity, directory, deps.dossier));
  return only(request, 'POST', () => decide(request, deps.store, key, action, identity, directory, today()));
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
): Promise<Response> {
  const file = await store.find(key);
  if (!file) return error(404, 'not_found');
  const dossierView = await proposalDossier(key, file, dossier);
  return Response.json({
    ...summary(file, directory(identity.email)),
    justification: file.proposal.justification,
    items: file.invoice.items.map((i) => ({
      supplierCode: i.supplierCode,
      sku: i.sku,
      description: i.description,
      quantity: { amount: i.quantity.amount, unit: i.quantity.unit },
      unitPrice: money(i.unitPrice),
      total: money(i.total),
    })),
    divergences: file.invoice.divergences.map((d) => ({
      classification: d.classification,
      skus: d.skus,
      evidence: d.evidence,
    })),
    title: { state: file.title.state, amount: money(file.title.amount), dueOn: file.title.dueOn },
    approval: file.approval,
    dossier: dossierView,
  });
}

/**
 * #68: o dossiê é conferido contra o banco na hora de mostrar; sem fonte, fica pendente. Um erro ao
 * ler não derruba a proposta (#38/AC-4): vira `read_failed` e fica no log só com a chave e a mensagem.
 */
async function proposalDossier(key: string, file: CaseFile, dossier?: DossierDeps): Promise<DossierField> {
  if (!dossier) return dossierField(null);
  try {
    const ctx = await dossier.context(key);
    return dossierField(await readDossier({ invoiceAccessKey: key, invoice: file.invoice, ctx, source: dossier.source }));
  } catch (e) {
    console.error(`#68 dossiê da nota ${key} não lido: ${e instanceof Error ? e.message : String(e)}`);
    return dossierReadFailed();
  }
}

/** AC-7 a AC-11: aprovar ou alterar, com o nível de quem passou pelo Access. */
async function decide(
  request: Request,
  store: ApprovalStore,
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

  const file = await store.find(key);
  if (!file) return error(404, 'not_found');
  try {
    const approval = approve(file.invoice, file.proposal, file.title, { email: identity.email, level }, decision, today, {
      paymentBlocked: file.supplierBlocked,
    });
    await store.saveDecision({ ...file, approval });
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
    dockAction: f.proposal.dockAction.kind,
    approver: f.approval?.approver ?? null,
  }));
  const total = scheduled.reduce((sum, f) => sum + f.title.amount.cents, 0);
  return Response.json({ day, items, total: { cents: total } });
}
