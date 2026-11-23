// #63 A loja da aprovação nas tabelas do domínio (#80): invoices, divergences, proposals, approvals, titles.
import {
  arrayOf,
  isInteger,
  isNumber,
  isRecord,
  isString,
  isUnknown,
  nullable,
  oneOf,
  parseRows,
  shaped,
  type Shape,
} from '../connectors/guards.js';
import { ErpRegistryConnector } from '../connectors/erp-registry.js';
import { postgresErrorOf, SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import { AmountAtRisk } from '../domain/amount-at-risk.js';
import type { Approval } from '../domain/approval.js';
import { ApprovalPolicy, type ApprovalRoute, type ReguaLine } from '../domain/approval-policy.js';
import { APPROVAL_LEVELS, type ApprovalLevel } from '../domain/approval-level.js';
import type { Classification } from '../domain/classification.js';
import { Divergence } from '../domain/divergence.js';
import { DockAction, type PartialLine } from '../domain/dock-action.js';
import type { Evidence } from '../domain/evidence.js';
import { Invoice, type InvoiceState } from '../domain/invoice.js';
import { Money } from '../domain/money.js';
import { Proposal, type ProposalState } from '../domain/proposal.js';
import { Quantity } from '../domain/quantity.js';
import { Title, type TitleState } from '../domain/title.js';
import { readLatestAudit } from './latest-audit.js';
import {
  AlreadyDecidedError,
  EngineApprovalRefusedError,
  ProposalVersionConflictError,
  type ApprovalStore,
  type CaseFile,
  type StoredAudit,
} from './store.js';

// #63 Formato das linhas, conferido na borda antes de virar domínio.

export type InvoiceRow = {
  access_key: string;
  number: string;
  series: string;
  supplier_id: string;
  store: string;
  issued_on: string;
  purchase_order_ref: string | null;
  entry_channel: string;
  total_cents: number;
  items: unknown;
  state: InvoiceState;
};

export type DivergenceRow = {
  invoice_access_key: string;
  seq: number;
  classification: string;
  skus: string[];
  evidence: unknown;
};

type ProposalRow = {
  id: number;
  invoice_access_key: string;
  classification: string;
  dock_action: unknown;
  approval_level: ApprovalLevel;
  amount_at_risk_cents: number;
  justification: string;
  state: ProposalState;
  regua_line: number | null;
  /** #295 A trava otimista: o gatilho do banco sobe a cada update. */
  version: number;
};

type ApprovalRow = {
  proposal_id: number;
  approver: string;
  approver_level: ApprovalLevel;
  justification: string | null;
  dock_action: unknown;
  decided_on: string | null;
  approved_at: string;
};

type TitleRow = {
  invoice_access_key: string;
  amount_cents: number;
  due_on: string;
  state: TitleState;
};

const isLevel = oneOf(...APPROVAL_LEVELS);

/** #63 A chave de acesso tem 44 dígitos; validar aqui protege os filtros `in.(...)` montados com ela. */
export const isAccessKey = (v: unknown): v is string => isString(v) && /^\d{44}$/.test(v);

export const isInvoiceRow = shaped<InvoiceRow>({
  access_key: isAccessKey,
  number: isString,
  series: isString,
  supplier_id: isString,
  store: isString,
  issued_on: isString,
  purchase_order_ref: nullable(isString),
  entry_channel: isString,
  total_cents: isInteger,
  items: isUnknown,
  state: oneOf('a_conferir', 'conferida', 'com_proposta', 'decidida'),
} satisfies Shape<InvoiceRow>);

export const isDivergenceRow = shaped<DivergenceRow>({
  invoice_access_key: isString,
  seq: isInteger,
  classification: isString,
  skus: arrayOf(isString),
  evidence: isUnknown,
} satisfies Shape<DivergenceRow>);

const isProposalRow = shaped<ProposalRow>({
  id: isInteger,
  invoice_access_key: isString,
  classification: isString,
  dock_action: isUnknown,
  approval_level: isLevel,
  amount_at_risk_cents: isInteger,
  justification: isString,
  state: oneOf('registrada', 'aguardando_aprovacao', 'aprovada', 'alterada'),
  regua_line: nullable(isInteger),
  version: isInteger,
} satisfies Shape<ProposalRow>);

const isApprovalRow = shaped<ApprovalRow>({
  proposal_id: isInteger,
  approver: isString,
  approver_level: isLevel,
  justification: nullable(isString),
  dock_action: isUnknown,
  decided_on: nullable(isString),
  approved_at: isString,
} satisfies Shape<ApprovalRow>);

const isTitleRow = shaped<TitleRow>({
  invoice_access_key: isString,
  amount_cents: isInteger,
  due_on: isString,
  state: oneOf('lancado', 'liberado', 'reduzido', 'bloqueado', 'na_lista_do_dia'),
} satisfies Shape<TitleRow>);

const CLASSIFICATIONS: readonly Classification[] = [
  'MATCH',
  'E1',
  'E2',
  'E3',
  'E4',
  'E5',
  'E6',
  'E7',
  'E8',
  'NAO_CATALOGADA',
];
export const isClassification = oneOf(...CLASSIFICATIONS);
const isEvidence = shaped<Evidence>({
  source: oneOf('sefaz', 'erp_compras', 'erp_contas_a_pagar', 'erp_cadastro', 'banco', 'wms'),
  reference: isString,
  description: isString,
} satisfies Shape<Evidence>);

export function corrupt(table: string, detail: string): never {
  throw new SupabaseRestError('parse', table, 0, detail);
}

// #63 Do JSON gravado ao domínio.

export function dockActionToJson(action: DockAction): unknown {
  if (action.kind !== 'receber_parcial') return { kind: action.kind };
  return {
    kind: action.kind,
    lines: action.lines.map((l) => ({
      sku: l.sku,
      quantity: { amount: l.quantity.amount, unit: l.quantity.unit },
      disposition: l.disposition,
    })),
  };
}

export function dockActionFromJson(raw: unknown, table: string): DockAction {
  if (!isRecord(raw)) corrupt(table, 'ação na doca fora do formato');
  if (raw.kind === 'receber') return DockAction.receive();
  if (raw.kind === 'recusar') return DockAction.refuse();
  if (raw.kind === 'receber_parcial' && Array.isArray(raw.lines)) {
    return DockAction.partial(
      raw.lines.map((l): PartialLine => {
        const q = isRecord(l) && isRecord(l.quantity) ? l.quantity : null;
        if (
          !isRecord(l) ||
          !isString(l.sku) ||
          !q ||
          !isNumber(q.amount) ||
          (q.unit !== 'UN' && q.unit !== 'CX') ||
          (l.disposition !== 'segurar' && l.disposition !== 'devolver')
        ) {
          corrupt(table, 'linha da ação parcial fora do formato');
        }
        return { sku: l.sku, quantity: Quantity.of(q.amount, q.unit), disposition: l.disposition };
      }),
    );
  }
  return corrupt(table, 'ação na doca desconhecida');
}

export function invoiceFromRows(row: InvoiceRow, divergences: readonly DivergenceRow[]): Invoice {
  if (!Array.isArray(row.items)) corrupt('invoices', 'itens fora do formato');
  const invoice = Invoice.receive({
    accessKey: row.access_key,
    number: row.number,
    series: row.series,
    supplierId: row.supplier_id,
    store: row.store,
    issuedOn: row.issued_on,
    purchaseOrderRef: row.purchase_order_ref,
    entryChannel: row.entry_channel,
    items: row.items.map((i) => {
      const q = isRecord(i) && isRecord(i.quantity) ? i.quantity : null;
      if (
        !isRecord(i) ||
        !isString(i.supplierCode) ||
        !(i.sku === null || isString(i.sku)) ||
        !isString(i.description) ||
        !q ||
        !isNumber(q.amount) ||
        (q.unit !== 'UN' && q.unit !== 'CX') ||
        !isInteger(i.unitPriceCents) ||
        !isInteger(i.totalCents)
      ) {
        return corrupt('invoices', 'item fora do formato');
      }
      return {
        supplierCode: i.supplierCode,
        sku: i.sku,
        description: i.description,
        quantity: Quantity.of(q.amount, q.unit),
        unitPrice: Money.ofCents(i.unitPriceCents),
        total: Money.ofCents(i.totalCents),
      };
    }),
    total: Money.ofCents(row.total_cents),
  });
  if (row.state === 'a_conferir') return invoice;
  const found = [...divergences]
    .sort((a, b) => a.seq - b.seq)
    .map((d) => {
      if (!isClassification(d.classification) || d.classification === 'MATCH') {
        return corrupt('divergences', 'classificação desconhecida');
      }
      if (!Array.isArray(d.evidence) || !d.evidence.every(isEvidence)) {
        return corrupt('divergences', 'evidência fora do formato');
      }
      return Divergence.of({ classification: d.classification, skus: d.skus, evidence: d.evidence });
    });
  // #63 O contrato não tem como montar a nota já conferida: a conferência roda de novo sobre o que foi gravado.
  invoice.check(
    { purchaseOrders: [], suppliers: [], products: [], postedInvoices: [], payments: [], receipts: [], capturedInvoices: [] },
    [{ id: 'NAO_CATALOGADA', run: () => found }],
  );
  if (row.state === 'com_proposta' || row.state === 'decidida') invoice.markProposed();
  if (row.state === 'decidida') invoice.markDecided();
  return invoice;
}

function proposalFromRow(row: ProposalRow, invoice: Invoice): Proposal {
  if (!isClassification(row.classification)) corrupt('proposals', 'classificação desconhecida');
  const dockAction = dockActionFromJson(row.dock_action, 'proposals');
  const proposal = Proposal.register({
    classification: row.classification,
    dockAction,
    level: row.approval_level,
    amountAtRisk: AmountAtRisk.of(Money.ofCents(row.amount_at_risk_cents), invoice.total),
    justification: row.justification,
  });
  if (row.state === 'registrada') return proposal;
  if (row.state === 'aprovada' && row.approval_level === 'regra') {
    proposal.approveByRule();
    return proposal;
  }
  proposal.awaitApproval();
  if (row.state === 'aprovada') proposal.approve();
  if (row.state === 'alterada') proposal.alter(dockAction, row.justification);
  return proposal;
}

function titleFromRow(row: TitleRow, invoice: Invoice): Title {
  const title = Title.post({ invoiceAccessKey: row.invoice_access_key, amount: invoice.total, dueOn: row.due_on });
  const amount = Money.ofCents(row.amount_cents);
  const reduced = !amount.equals(invoice.total);
  switch (row.state) {
    case 'lancado':
      break;
    case 'liberado':
      title.release();
      break;
    case 'reduzido':
      title.reduce(amount);
      break;
    case 'bloqueado':
      title.block();
      break;
    case 'na_lista_do_dia':
      if (reduced) title.reduce(amount);
      else title.release();
      title.scheduleToday();
      break;
  }
  return title;
}

function isReguaLine(v: number | null): v is ReguaLine {
  return v !== null && Number.isInteger(v) && v >= 1 && v <= 6;
}

function routeFromRow(row: ProposalRow, invoice: Invoice): ApprovalRoute {
  const computed = ApprovalPolicy.route(invoice);
  const line = isReguaLine(row.regua_line) ? row.regua_line : computed.line;
  return { level: row.approval_level, line, reason: ApprovalPolicy.reasonOf(line) };
}

function approvalFromRow(row: ApprovalRow, proposal: Proposal): Approval {
  return {
    approver: row.approver,
    approverLevel: row.approver_level,
    dockAction: row.dock_action ? dockActionFromJson(row.dock_action, 'approvals') : proposal.dockAction,
    justification: row.justification ?? proposal.justification,
    decidedOn: row.decided_on ?? row.approved_at.slice(0, 10),
  };
}

/** #63 As notas conferidas e ainda sem proposta, com as divergências gravadas. */
export async function loadCheckedInvoices(rest: SupabaseRest, limit?: number): Promise<Invoice[]> {
  const invoices = parseRows(
    // #356 AC-4 `limit` é o teto de notas por chamada do passo da rodada; sem ele, todas.
    await rest.select('invoices', { filters: { state: 'eq.conferida' }, order: 'access_key', ...(limit === undefined ? {} : { limit }) }),
    isInvoiceRow,
    'invoices',
  );
  if (invoices.length === 0) return [];
  const keyFilter = `in.(${invoices.map((i) => `"${i.access_key}"`).join(',')})`;
  const divergences = parseRows(
    await rest.select('divergences', { filters: { invoice_access_key: keyFilter } }),
    isDivergenceRow,
    'divergences',
  );
  return invoices.map((row) =>
    invoiceFromRows(
      row,
      divergences.filter((d) => d.invoice_access_key === row.access_key),
    ),
  );
}

/**
 * #42 O que o banco responde à aprovação do motor, na língua da loja. A unicidade (`approvals_proposal_key`, a
 * pessoa ou outra rodada chegou antes; `approvals_engine_decision_key`, a decisão já gerou uma aprovação) é a mesma
 * corrida de sempre: `AlreadyDecidedError`. O gatilho da migração 20261117120000 recusa com 23514 a delegação
 * desligada (a proposta fica com a pessoa) e com 23503/23514 a aprovação que não bate com a decisão ou com a
 * proposta (erro de programação). O resto segue como veio.
 */
function engineRefusal(error: unknown, invoiceAccessKey: string): unknown {
  const pg = postgresErrorOf(error);
  if (!pg) return error;
  if (pg.code === '23505') return new AlreadyDecidedError(invoiceAccessKey);
  if (pg.code === '23514' && /delega/i.test(pg.message)) return new EngineApprovalRefusedError(invoiceAccessKey, 'delegation_off');
  if (pg.code === '23514' || pg.code === '23503') return new EngineApprovalRefusedError(invoiceAccessKey, 'mismatch');
  return error;
}

/** #63 A loja da aprovação no Supabase. Lê as tabelas inteiras: são poucas notas por dia (vai para a #76). */
export class SupabaseApprovalStore implements ApprovalStore {
  constructor(
    private readonly rest: SupabaseRest,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listAwaiting(): Promise<CaseFile[]> {
    return (await this.load({ state: 'eq.aguardando_aprovacao' })).filter((f) => f.approval === null);
  }

  async find(invoiceAccessKey: string): Promise<CaseFile | null> {
    const [file] = await this.load({ invoice_access_key: `eq.${invoiceAccessKey}` });
    if (!file) return null;
    return { ...file, audit: await this.latestAudit(invoiceAccessKey) };
  }

  /**
   * #371 Duas leituras para o lote todo: as propostas das chaves (estado e versão) e as aprovações delas. Segue aguardando quem está
   * `aguardando_aprovacao`, sem aprovação e na versão que o lote leu; o resto (a pessoa decidiu, a proposta mudou, sumiu) fica com a pessoa.
   */
  async reread(files: readonly CaseFile[]): Promise<ReadonlySet<string>> {
    const keys = files.map((f) => f.invoice.accessKey);
    if (keys.length === 0) return new Set();
    if (!keys.every(isAccessKey)) corrupt('proposals', 'chave de acesso fora do formato');
    const proposals = parseRows(
      await this.rest.select('proposals', { select: 'id,invoice_access_key,state,version', filters: { invoice_access_key: `in.(${keys.map((k) => `"${k}"`).join(',')})` } }),
      shaped<{ id: number; invoice_access_key: string; state: string; version: number }>({ id: isInteger, invoice_access_key: isString, state: isString, version: isInteger }),
      'proposals',
    );
    const awaiting = proposals.filter((p) => p.state === 'aguardando_aprovacao');
    if (awaiting.length === 0) return new Set();
    const decided = new Set(
      parseRows(
        await this.rest.select('approvals', { select: 'proposal_id', filters: { proposal_id: `in.(${awaiting.map((p) => p.id).join(',')})` } }),
        shaped<{ proposal_id: number }>({ proposal_id: isInteger }),
        'approvals',
      ).map((a) => a.proposal_id),
    );
    const readVersion = new Map(files.map((f) => [f.invoice.accessKey, f.version]));
    return new Set(awaiting.filter((p) => !decided.has(p.id) && readVersion.get(p.invoice_access_key) === p.version).map((p) => p.invoice_access_key));
  }

  /** #230 AC-7 Um erro ao ler a auditoria não derruba a proposta: audit vai nula, e o log traz só o tipo do erro. */
  private async latestAudit(invoiceAccessKey: string): Promise<StoredAudit | null> {
    try {
      return await readLatestAudit(this.rest, invoiceAccessKey);
    } catch (e) {
      console.error(`#230 auditoria da nota ${invoiceAccessKey} não lida: ${e instanceof Error ? e.name : 'erro'}`);
      return null;
    }
  }

  async listDecidedOn(day: string): Promise<CaseFile[]> {
    return (await this.load({ state: 'in.(aprovada,alterada)' })).filter((f) => f.approval?.decidedOn === day);
  }

  /**
   * #304 A decisão numa só chamada rpc à função `save_approval_decision` do banco: aprovação, proposta, título e nota
   * mudam juntos numa transação, ou nenhum muda. A função trava a proposta e responde: `already_decided` (regra 8:
   * quem chega depois perde, e a checagem vem antes da de versão, porque a primeira decisão sobe a versão),
   * `version_conflict` (#295: a proposta mudou desde a leitura em `find`, `file.version`) ou `saved`. A restrição única
   * de `approvals.proposal_id` segue como última guarda, e os gatilhos do motor recusam com erro do Postgres.
   */
  async saveDecision(file: CaseFile & { readonly approval: Approval }): Promise<void> {
    const key = file.invoice.accessKey;
    // #295 Sem a versão lida não há o que conferir: é erro de programação (o chamador não veio de `find`), e nada se grava.
    const { version } = file;
    if (version === undefined) throw new Error(`#295 saveDecision da nota ${key} sem a versão lida da proposta: leia com find()`);
    const { approval } = file;
    const now = this.now().toISOString();
    let result: unknown;
    try {
      result = await this.rest.rpc('save_approval_decision', {
        p_invoice_access_key: key,
        p_version: version,
        p_approver: approval.approver,
        p_approver_level: approval.approverLevel,
        p_approval_justification: approval.justification,
        p_approval_dock_action: dockActionToJson(approval.dockAction),
        p_decided_on: approval.decidedOn,
        p_approved_at: now,
        p_proposal_state: file.proposal.state,
        p_proposal_dock_action: dockActionToJson(file.proposal.dockAction),
        p_proposal_justification: file.proposal.justification,
        p_title_state: file.title.state,
        p_title_amount_cents: file.title.amount.cents,
        p_title_updated_at: now,
        p_invoice_state: file.invoice.state,
        // #42 A aprovação do motor leva a decisão que a gerou. `approved_by` é gerada pelo banco: nunca vai aqui.
        ...(approval.engine
          ? {
              p_engine_decision_id: approval.engine.decisionId,
              p_engine_confidence: approval.engine.confidence,
              p_engine_model_version: approval.engine.modelVersion,
            }
          : {}),
      });
    } catch (error) {
      throw approval.engine ? engineRefusal(error, key) : error;
    }
    if (result === 'already_decided') throw new AlreadyDecidedError(key);
    if (result === 'version_conflict') throw new ProposalVersionConflictError(key);
    if (result !== 'saved') corrupt('rpc/save_approval_decision', 'resposta fora de saved, already_decided e version_conflict');
  }

  /** #63 Monta os processos das propostas que passam no filtro. */
  private async load(proposalFilters: Readonly<Record<string, string>>): Promise<CaseFile[]> {
    const proposals = parseRows(
      await this.rest.select('proposals', { filters: proposalFilters, order: 'id' }),
      isProposalRow,
      'proposals',
    );
    if (proposals.length === 0) return [];
    const keys = proposals.map((p) => p.invoice_access_key);
    if (!keys.every(isAccessKey)) corrupt('proposals', 'chave de acesso fora do formato');
    const keyFilter = `in.(${keys.map((k) => `"${k}"`).join(',')})`;
    const ids = `in.(${proposals.map((p) => p.id).join(',')})`;
    const [invoices, divergences, titles, approvals, suppliers] = await Promise.all([
      this.rest.select('invoices', { filters: { access_key: keyFilter } }),
      this.rest.select('divergences', { filters: { invoice_access_key: keyFilter } }),
      this.rest.select('titles', { filters: { invoice_access_key: keyFilter } }),
      this.rest.select('approvals', { filters: { proposal_id: ids } }),
      new ErpRegistryConnector(this.rest).listSuppliers(),
    ]);
    const blocked = new Set(suppliers.filter((s) => s.paymentBlocked).map((s) => s.id));
    const invoiceRows = new Map(parseRows(invoices, isInvoiceRow, 'invoices').map((r) => [r.access_key, r]));
    const divergenceRows = parseRows(divergences, isDivergenceRow, 'divergences');
    const titleRows = new Map(parseRows(titles, isTitleRow, 'titles').map((r) => [r.invoice_access_key, r]));
    const approvalRows = new Map(parseRows(approvals, isApprovalRow, 'approvals').map((r) => [r.proposal_id, r]));

    return proposals.flatMap((p): CaseFile[] => {
      const invoiceRow = invoiceRows.get(p.invoice_access_key);
      const titleRow = titleRows.get(p.invoice_access_key);
      if (!invoiceRow || !titleRow) return [];
      const invoice = invoiceFromRows(
        invoiceRow,
        divergenceRows.filter((d) => d.invoice_access_key === p.invoice_access_key),
      );
      const proposal = proposalFromRow(p, invoice);
      const approvalRow = approvalRows.get(p.id);
      return [
        {
          invoice,
          proposal,
          title: titleFromRow(titleRow, invoice),
          route: routeFromRow(p, invoice),
          approval: approvalRow ? approvalFromRow(approvalRow, proposal) : null,
          supplierBlocked: blocked.has(invoice.supplierId),
          version: p.version,
        },
      ];
    });
  }
}
