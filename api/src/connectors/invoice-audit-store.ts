// #230 A auditoria da nota no Supabase (tabela invoice_audits, só recebe linhas) e a leitura da mais recente.
// #230 Cada escrita é uma requisição PostgREST própria (uma transação cada); não há transação entre a auditoria e
// #230 o nível da proposta, e o contrato de duas gravações em ordem está no InvoiceAuditPort.
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
import { isRecord, isString, isUnknown, oneOf, parseOne, parseRows, shaped, type Shape } from './guards.js';
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

type SweepRow = { invoice_access_key: string; raised_level: ApprovalLevel; invoices: unknown };
const isSweepRow = shaped<SweepRow>({ invoice_access_key: isString, raised_level: isLevel, invoices: isUnknown } satisfies Shape<SweepRow>);

/** #230 Os níveis estritamente abaixo de `level`, no formato do filtro `in.(...)` do PostgREST. */
const belowFilter = (level: ApprovalLevel): string =>
  `in.(${APPROVAL_LEVELS.filter((l) => compareLevels(l, level) < 0).join(',')})`;

/** #230 SQLSTATE de violação de unicidade. */
const UNIQUE_VIOLATION = '23505';

const KEY_PATTERN = /^[A-Za-z0-9-]+$/;

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

  /** #230 AC-1 e AC-3: a linha primeiro (a verdade); depois, só se ela entrou e há nível a subir, o PATCH guardado. */
  async save(invoiceAccessKey: string, result: AuditResult, context: AuditWriteContext): Promise<void> {
    if (!(await this.insertAudit(invoiceAccessKey, result, context))) return;
    const { raisedLevel } = result;
    if (raisedLevel === null) return;
    // #230 A linha já está gravada: se a subida falhar, o save não falha (falhar faria o caso de uso reauditar);
    // #230 a varredura (reapplyRaisedLevels) repete a subida, que é idempotente. O alerta não leva chave nem texto.
    try {
      const touched = await this.raise(invoiceAccessKey, raisedLevel);
      // #230 Nenhuma proposta tocada: já decidida ou já no nível. Vale só como alerta, sem a chave nem o texto.
      if (touched === 0) this.log('#230 invoice-audit: a auditoria pede nível mais alto, mas a proposta não está mais à espera abaixo dele');
    } catch {
      this.log('#230 invoice-audit: a subida de nível falhou; a varredura repete');
    }
  }

  /**
   * #230 Insert simples. O PostgREST usaria a chave primária como alvo do ignore-duplicates, e on_conflict não infere
   * um índice parcial (42P10): quem decide "já auditada" é o índice único parcial, que responde 409 com 23505.
   * Devolve false nesse caso (no-op); o 409 de outro código (23503, chave estrangeira) segue como falha.
   */
  private async insertAudit(invoiceAccessKey: string, result: AuditResult, context: AuditWriteContext): Promise<boolean> {
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
      raised_level: raisedLevel,
      raised_from_level: raisedLevel === null ? null : context.fromLevel,
      injection_flag: injectionFlag,
      refusals: [...context.refusals],
    };
    try {
      await this.rest.insert('invoice_audits', [row], { ignoreDuplicates: false });
      return true;
    } catch (error) {
      if (error instanceof SupabaseRestError && error.status === 409 && error.code === UNIQUE_VIOLATION) return false;
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
   * #230 Reparo: uma leitura (auditorias com nível elevado, com a proposta embutida) e, no máximo, uma gravação em
   * lote, do nível mais alto que ainda precisa de reparo; os demais ficam para a próxima varredura (idempotente).
   */
  async reapplyRaisedLevels(): Promise<void> {
    const rows = parseRows(
      await this.rest.select('invoice_audits', {
        select: 'invoice_access_key,raised_level,invoices(proposals(state,approval_level))',
        filters: { raised_level: 'not.is.null' },
        order: 'id',
      }),
      isSweepRow,
      'invoice_audits',
    );
    const pending = rows.filter((r) => {
      const proposal = isRecord(r.invoices) && isRecord(r.invoices.proposals) ? r.invoices.proposals : null;
      return (
        KEY_PATTERN.test(r.invoice_access_key) &&
        proposal !== null &&
        proposal.state === 'aguardando_aprovacao' &&
        isLevel(proposal.approval_level) &&
        compareLevels(proposal.approval_level, r.raised_level) < 0
      );
    });
    const highest = pending.reduce<ApprovalLevel | null>((top, r) => (top === null || compareLevels(r.raised_level, top) > 0 ? r.raised_level : top), null);
    if (highest === null) return;
    const keys = pending.filter((r) => r.raised_level === highest).map((r) => r.invoice_access_key);
    await this.rest.update(
      'proposals',
      { invoice_access_key: `in.(${keys.join(',')})`, state: 'eq.aguardando_aprovacao', approval_level: belowFilter(highest) },
      { approval_level: highest },
    );
  }

  private async raise(invoiceAccessKey: string, level: ApprovalLevel): Promise<number> {
    const touched = await this.rest.update(
      'proposals',
      { invoice_access_key: `eq.${invoiceAccessKey}`, state: 'eq.aguardando_aprovacao', approval_level: belowFilter(level) },
      { approval_level: level },
    );
    return touched.length;
  }
}
