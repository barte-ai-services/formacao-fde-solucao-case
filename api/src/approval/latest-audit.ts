// #230 AC-7 A leitura da auditoria corrente de uma nota (a linha mais recente de invoice_audits), para a API.
import {
  APPROVAL_LEVELS,
  AUDIT_CLASSIFICATIONS,
  AUDIT_DOCK_ACTIONS,
  type ApprovalLevel,
  type AuditRefusal,
  type NotAuditedReason,
} from '../domain/index.js';
import { arrayOf, isInteger, isRecord, isString, isUnknown, nullable, oneOf, parseOne, shaped, type Guard, type Shape } from '../connectors/guards.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import type { StoredAudit } from './store.js';

const isLevel = oneOf(...APPROVAL_LEVELS);
const isReason = oneOf<NotAuditedReason>('claude_falhou', 'erro_de_tool', 'sem_auditoria');
const isField = oneOf('classification', 'dock_action', 'routing');

const isRefusal: Guard<AuditRefusal> = (v): v is AuditRefusal =>
  isRecord(v) &&
  ((v.refusal === 'invalid_field' && isString(v.field)) || (v.refusal === 'routing_below_regua' && isLevel(v.minimumLevel)));

type AuditRow = {
  id: number;
  status: 'audited' | 'nao_auditada';
  reason: NotAuditedReason | null;
  classification: string | null;
  dock_action: unknown;
  routing: ApprovalLevel | null;
  justification: string | null;
  amount_at_risk_cents: number | null;
  model: string | null;
  audited_at: string | null;
  differing_fields: ('classification' | 'dock_action' | 'routing')[] | null;
  injection_flag: string | null;
  refusals: AuditRefusal[];
};

const isAuditRow = shaped<AuditRow>({
  id: isInteger,
  status: oneOf('audited', 'nao_auditada'),
  reason: nullable(isReason),
  classification: nullable(isString),
  dock_action: isUnknown,
  routing: nullable(isLevel),
  justification: nullable(isString),
  amount_at_risk_cents: nullable(isInteger),
  model: nullable(isString),
  audited_at: nullable(isString),
  differing_fields: nullable(arrayOf(isField)),
  injection_flag: nullable(isString),
  refusals: arrayOf(isRefusal),
} satisfies Shape<AuditRow>);

function corrupt(detail: string): never {
  throw new SupabaseRestError('parse', 'invoice_audits', 0, detail);
}

const isChange = shaped<{ to_level: ApprovalLevel }>({ to_level: isLevel });

/**
 * #230 AC-3 O nível que a subida desta auditoria aplicou (proposal_level_changes, a mais recente, por invoice-audit), ou
 * null se nenhuma foi aplicada: o pedido guardado em invoice_audits.requested_level não vale como fato.
 */
async function appliedLevel(rest: SupabaseRest, invoiceAuditId: number): Promise<ApprovalLevel | null> {
  const rows = await rest.select('proposal_level_changes', {
    select: 'to_level',
    filters: { invoice_audit_id: `eq.${invoiceAuditId}`, changed_by: 'eq.invoice-audit' },
    order: 'id.desc',
    limit: 1,
  });
  const [raw] = rows;
  if (raw === undefined) return null;
  return parseOne(raw, isChange, 'proposal_level_changes').to_level;
}

/** #230 AC-7 A auditoria feita da nota, ou, sem ela, a tentativa mais recente (status asc, id desc, limit 1) como a API a lê, ou null se nunca foi tentada. */
export async function readLatestAudit(rest: SupabaseRest, invoiceAccessKey: string): Promise<StoredAudit | null> {
  const rows = await rest.select('invoice_audits', {
    filters: { invoice_access_key: `eq.${invoiceAccessKey}` },
    // #230 'audited' vem antes de 'nao_auditada' (ordem alfabética): uma tentativa falha posterior não esconde a auditoria feita.
    order: 'status.asc,id.desc',
    limit: 1,
  });
  const [raw] = rows;
  if (raw === undefined) return null;
  const row = parseOne(raw, isAuditRow, 'invoice_audits');
  if (row.status === 'nao_auditada') {
    if (row.reason === null) corrupt('motivo ausente');
    return { status: 'nao_auditada', reason: row.reason, refusals: row.refusals };
  }
  const classification = AUDIT_CLASSIFICATIONS.find((c) => c === row.classification);
  if (
    classification === undefined ||
    row.routing === null ||
    row.justification === null ||
    row.model === null ||
    row.audited_at === null ||
    row.differing_fields === null
  ) {
    return corrupt('auditoria incompleta');
  }
  const auditedAt = new Date(row.audited_at);
  if (Number.isNaN(auditedAt.getTime())) corrupt('data fora do formato');
  // #230 O que se grava é só o `kind` da ação que o auditor opina; as linhas da parcial são da proposta.
  const dockAction = AUDIT_DOCK_ACTIONS.find((a) => isRecord(row.dock_action) && row.dock_action.kind === a);
  if (dockAction === undefined) return corrupt('ação fora do formato');
  return {
    status: 'auditada',
    classification,
    dockAction,
    routing: row.routing,
    justification: row.justification,
    amountAtRiskCents: row.amount_at_risk_cents,
    model: row.model,
    auditedAt: auditedAt.toISOString(),
    differs: row.differing_fields,
    raisedLevel: await appliedLevel(rest, row.id),
    injectionFlag: row.injection_flag,
    refusals: row.refusals,
  };
}

