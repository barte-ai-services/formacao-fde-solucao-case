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
  raised_level: ApprovalLevel | null;
  injection_flag: string | null;
  refusals: AuditRefusal[];
};

const isAuditRow = shaped<AuditRow>({
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
  raised_level: nullable(isLevel),
  injection_flag: nullable(isString),
  refusals: arrayOf(isRefusal),
} satisfies Shape<AuditRow>);

function corrupt(detail: string): never {
  throw new SupabaseRestError('parse', 'invoice_audits', 0, detail);
}

/** #230 AC-7 A linha mais recente da nota (id desc, limit 1) como a API a lê, ou null se nunca foi tentada. */
export async function readLatestAudit(rest: SupabaseRest, invoiceAccessKey: string): Promise<StoredAudit | null> {
  const rows = await rest.select('invoice_audits', {
    filters: { invoice_access_key: `eq.${invoiceAccessKey}` },
    order: 'id.desc',
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
    raisedLevel: row.raised_level,
    injectionFlag: row.injection_flag,
    refusals: row.refusals,
  };
}

