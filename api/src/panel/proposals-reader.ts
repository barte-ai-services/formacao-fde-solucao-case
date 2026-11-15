// Lê as propostas e as aprovações pelo PostgREST e junta no formato do painel (#71).
import type { Classification } from '../domain/classification.js';
import type { DockAction } from '../domain/dock-action.js';
import { isInteger, isString, oneOf, parseRows, shaped, type Guard, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import type { ProposalRecord } from './barred-amount.js';

/** #71: registrada nunca entra no painel; as outras três sim. */
const PANEL_STATES = ['aguardando_aprovacao', 'aprovada', 'alterada'] as const;

type ProposalRow = {
  id: number;
  classification: Classification;
  dock_action: { kind: DockAction['kind'] };
  amount_at_risk_cents: number;
  state: (typeof PANEL_STATES)[number];
  created_at: string;
};

type ApprovalRow = { proposal_id: number; approved_at: string };

const isInstant: Guard<string> = (v): v is string => isString(v) && !Number.isNaN(Date.parse(v));

const isClassification = oneOf<Classification>(
  'MATCH', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'NAO_CATALOGADA',
);

const isDockActionKind = shaped<{ kind: DockAction['kind'] }>({
  kind: oneOf('receber', 'receber_parcial', 'recusar'),
});

const isProposalRow = shaped<ProposalRow>({
  id: isInteger,
  classification: isClassification,
  dock_action: isDockActionKind,
  amount_at_risk_cents: isInteger,
  state: oneOf(...PANEL_STATES),
  created_at: isInstant,
} satisfies Shape<ProposalRow>);

const isApprovalRow = shaped<ApprovalRow>({
  proposal_id: isInteger,
  approved_at: isInstant,
} satisfies Shape<ApprovalRow>);

/**
 * #71: lê as propostas que o painel usa e a data da aprovação de cada uma. Sem filtro de data no
 * banco: a decisão de um mês pode ser de uma proposta criada antes, e a data vem de outra tabela.
 */
export async function readProposalRecords(rest: SupabaseRest): Promise<ProposalRecord[]> {
  const [proposals, approvals] = await Promise.all([
    rest.select('proposals', {
      select: 'id,classification,dock_action,amount_at_risk_cents,state,created_at',
      filters: { state: `in.(${PANEL_STATES.join(',')})` },
      order: 'id',
    }),
    rest.select('approvals', { select: 'proposal_id,approved_at', order: 'proposal_id' }),
  ]);
  const approvedAt = new Map(
    parseRows(approvals, isApprovalRow, 'approvals').map((a) => [a.proposal_id, a.approved_at]),
  );
  return parseRows(proposals, isProposalRow, 'proposals').map((row) => ({
    id: row.id,
    classification: row.classification,
    dockActionKind: row.dock_action.kind,
    amountAtRiskCents: row.amount_at_risk_cents,
    state: row.state,
    createdAt: row.created_at,
    approvedAt: approvedAt.get(row.id) ?? null,
  }));
}
