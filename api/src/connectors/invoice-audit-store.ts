// #230 A auditoria da nota no Supabase (tabela invoice_audits, só recebe linhas) e a leitura da mais recente.
// #230 Cada escrita é uma requisição PostgREST própria (uma transação cada). A subida do nível da proposta e a história
// #230 dela (proposal_level_changes) são uma só chamada da função raise_proposal_level, uma transação; entre a auditoria
// #230 e a subida há duas gravações em ordem, como diz o InvoiceAuditPort.
import { dockActionFromJson, invoiceFromRows, isDivergenceRow, isInvoiceRow } from '../approval/supabase-store.js';
import {
  APPROVAL_LEVELS,
  AUDIT_CLASSIFICATIONS,
  compareLevels,
  type ApprovalLevel,
  type AuditRefusal,
  type AuditResult,
  type NotAudited,
  type RuleProposal,
} from '../domain/index.js';
import { isInteger, isRecord, isString, isUnknown, oneOf, parseOne, parseRows, shaped, type Shape } from './guards.js';
import type { AuditedNote, AuditWriteContext, InvoiceAuditPort } from './ports.js';
import { SupabaseRestError, type SupabaseRest } from './supabase-rest.js';

const isLevel = oneOf(...APPROVAL_LEVELS);

function corrupt(detail: string): never {
  throw new SupabaseRestError('parse', 'invoice_audits', 0, detail);
}

type ProposalWithInvoice = {
  classification: string;
  dock_action: unknown;
  approval_level: ApprovalLevel;
  state: RuleProposal['state'];
  invoices: unknown;
};

const isProposalWithInvoice = shaped<ProposalWithInvoice>({
  classification: isString,
  dock_action: isUnknown,
  approval_level: isLevel,
  state: oneOf('registrada', 'aguardando_aprovacao', 'aprovada', 'alterada'),
  invoices: isUnknown,
} satisfies Shape<ProposalWithInvoice>);

type SweepRow = { id: number; invoice_access_key: string; requested_level: ApprovalLevel; invoices: unknown };
const isSweepRow = shaped<SweepRow>({
  id: isInteger,
  invoice_access_key: isString,
  requested_level: isLevel,
  invoices: isUnknown,
} satisfies Shape<SweepRow>);

const isInsertedRow = shaped<{ id: number }>({ id: isInteger });

/** #230 A função do banco que sobe o nível e grava a história na mesma transação. */
const RAISE_FUNCTION = 'raise_proposal_level';

/** #230 SQLSTATE de violação de unicidade. */
const UNIQUE_VIOLATION = '23505';

/** #230 Linhas lidas por varredura do reparo: o limite faz o SupabaseRest não paginar (uma requisição, qualquer tamanho de tabela). */
const SWEEP_LIMIT = 50;

export class SupabaseInvoiceAudits implements InvoiceAuditPort {
  constructor(
    private readonly rest: SupabaseRest,
    /** #230 Linha fixa de alerta (sem dados da nota); por padrão, o console do Worker. */
    private readonly log: (line: string) => void = (line) => console.error(line),
  ) {}

  /** #230 Uma requisição: a proposta com a nota e as divergências embutidas (as chaves estrangeiras as ligam). */
  async loadNote(invoiceAccessKey: string): Promise<AuditedNote | null> {
    const rows = await this.rest.select('proposals', {
      select: '*,invoices(*,divergences(*))',
      filters: { invoice_access_key: `eq.${invoiceAccessKey}` },
      limit: 1,
    });
    const [raw] = rows;
    if (raw === undefined) return null;
    const proposal = parseOne(raw, isProposalWithInvoice, 'proposals');
    const embedded = proposal.invoices;
    if (!isRecord(embedded)) return corrupt('nota da proposta ausente');
    const divergences = parseRows(Array.isArray(embedded.divergences) ? embedded.divergences : [], isDivergenceRow, 'divergences');
    const invoice = invoiceFromRows(parseOne(embedded, isInvoiceRow, 'invoices'), divergences);
    const classification = AUDIT_CLASSIFICATIONS.find((c) => c === proposal.classification);
    if (classification === undefined) return corrupt('classificação desconhecida');
    return {
      invoice,
      proposal: {
        classification,
        dockAction: dockActionFromJson(proposal.dock_action, 'proposals').kind,
        level: proposal.approval_level,
        state: proposal.state,
      },
    };
  }

  /** #230 AC-1 e AC-3: a linha primeiro (a verdade); depois, só se ela entrou e há nível a subir, a função que sobe e grava a história. */
  async save(invoiceAccessKey: string, result: AuditResult, context: AuditWriteContext): Promise<void> {
    const auditId = await this.insertAudit(invoiceAccessKey, result, context);
    if (auditId === null) return;
    const { raisedLevel } = result;
    if (raisedLevel === null) return;
    // #230 A linha já está gravada: se a subida falhar, o save não falha (falhar faria o caso de uso reauditar);
    // #230 a varredura (reapplyRaisedLevels) repete a subida, que é idempotente. O alerta leva a chave da nota, nunca o texto do erro.
    try {
      const applied = await this.raise(invoiceAccessKey, raisedLevel, auditId);
      // #230 Nada subiu: proposta já decidida ou já no nível. Vale só como alerta.
      if (applied === null) this.log(`#230 invoice-audit: a auditoria da nota ${invoiceAccessKey} pede nível mais alto, mas a proposta não está mais à espera abaixo dele`);
    } catch {
      this.log(`#230 invoice-audit: subida de nível da nota ${invoiceAccessKey} falhou; a varredura repete`);
    }
  }

  /**
   * #230 Insert simples. O PostgREST usaria a chave primária como alvo do ignore-duplicates, e on_conflict não infere
   * um índice parcial (42P10): quem decide "já auditada" é o índice único parcial, que responde 409 com 23505.
   * Devolve null nesse caso (no-op) e, senão, o id da linha; o 409 de outro código (23503, chave estrangeira) segue como falha.
   */
  private async insertAudit(invoiceAccessKey: string, result: AuditResult, context: AuditWriteContext): Promise<number | null> {
    const { audit, agreement, raisedLevel, injectionFlag } = result;
    const row = {
      invoice_access_key: invoiceAccessKey,
      status: 'audited',
      reason: null,
      classification: audit.classification,
      dock_action: { kind: audit.dockAction },
      routing: audit.routing,
      justification: audit.justification,
      amount_at_risk_cents: audit.amountAtRisk?.cents ?? null,
      model: audit.model,
      audited_at: audit.auditedAt,
      differing_fields: agreement.agrees ? [] : [...agreement.differs],
      requested_level: raisedLevel,
      requested_from_level: raisedLevel === null ? null : context.fromLevel,
      injection_flag: injectionFlag,
      refusals: [...context.refusals],
    };
    try {
      const [inserted] = await this.rest.insert('invoice_audits', [row], { ignoreDuplicates: false });
      return parseOne(inserted, isInsertedRow, 'invoice_audits').id;
    } catch (error) {
      if (error instanceof SupabaseRestError && error.status === 409 && error.code === UNIQUE_VIOLATION) return null;
      throw error;
    }
  }

  async saveNotAudited(invoiceAccessKey: string, outcome: NotAudited, refusals: readonly AuditRefusal[]): Promise<void> {
    await this.rest.insert(
      'invoice_audits',
      [{ invoice_access_key: invoiceAccessKey, status: 'nao_auditada', reason: outcome.reason, refusals: [...refusals] }],
      { ignoreDuplicates: false },
    );
  }

  /**
   * #230 Reparo: uma leitura e, no máximo, uma chamada da função, qualquer que seja o tamanho da tabela. A leitura traz,
   * do servidor, só as auditorias com nível pedido cuja proposta ainda espera (embutidos !inner), as SWEEP_LIMIT mais
   * antigas e sem paginar; a primeira abaixo do nível pedido é reparada e as demais ficam para a próxima varredura
   * (idempotente: a função só sobe).
   */
  async reapplyRaisedLevels(): Promise<void> {
    const rows = parseRows(
      await this.rest.select('invoice_audits', {
        select: 'id,invoice_access_key,requested_level,invoices!inner(proposals!inner(state,approval_level))',
        filters: { requested_level: 'not.is.null', 'invoices.proposals.state': 'eq.aguardando_aprovacao' },
        order: 'id.asc',
        limit: SWEEP_LIMIT,
      }),
      isSweepRow,
      'invoice_audits',
    );
    const pending = rows.find((r) => {
      const proposal = isRecord(r.invoices) && isRecord(r.invoices.proposals) ? r.invoices.proposals : null;
      return (
        proposal !== null &&
        proposal.state === 'aguardando_aprovacao' &&
        isLevel(proposal.approval_level) &&
        compareLevels(proposal.approval_level, r.requested_level) < 0
      );
    });
    if (pending === undefined) return;
    await this.raise(pending.invoice_access_key, pending.requested_level, pending.id);
  }

  /** #230 Uma chamada, uma transação: sobe o nível e grava a história. Devolve o nível aplicado, ou null se nada subiu. */
  private async raise(invoiceAccessKey: string, level: ApprovalLevel, auditId: number): Promise<ApprovalLevel | null> {
    const applied = await this.rest.rpc(RAISE_FUNCTION, {
      p_invoice_access_key: invoiceAccessKey,
      p_to_level: level,
      p_invoice_audit_id: auditId,
    });
    if (applied === null) return null;
    if (!isLevel(applied)) return corrupt('nível aplicado fora do formato');
    return applied;
  }
}
