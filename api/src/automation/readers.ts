// #211 O que a API lê do banco para a faixa, os indicadores e a linha do tempo. Só leitura.
import { isInteger, isString, nullable, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import type { DossierSource } from '../dossier/source.js';
import type { DecisionRecord } from './indicators.js';
import type { TimelineTimes } from './timeline.js';

const ACCESS_KEY = /^[A-Za-z0-9-]+$/;

type InvoiceTimes = { captured_at: string; checked_at: string | null };
type ProposalRow = { id: number; invoice_access_key: string; created_at: string };
type ApprovalRow = { proposal_id: number; approver_level: string; approved_at: string };
type OutboxRow = { published_at: string };

const isInvoiceTimes = shaped<InvoiceTimes>({ captured_at: isString, checked_at: nullable(isString) } satisfies Shape<InvoiceTimes>);
const isProposal = shaped<ProposalRow>({ id: isInteger, invoice_access_key: isString, created_at: isString } satisfies Shape<ProposalRow>);
const isApproval = shaped<ApprovalRow>({ proposal_id: isInteger, approver_level: isString, approved_at: isString } satisfies Shape<ApprovalRow>);
const isOutbox = shaped<OutboxRow>({ published_at: isString } satisfies Shape<OutboxRow>);

/** #211 AC-5 Todas as decisões, com a captura da nota, para os indicadores. */
/** #211 Lê só as decisões do mês corrente (Brasília, UTC-3); os indicadores não usam mais que isso. */
export async function readDecisionRecords(rest: SupabaseRest, monthStart: string): Promise<DecisionRecord[]> {
  const [approvals, proposals, invoices] = await Promise.all([
    rest.select('approvals', { select: 'proposal_id,approver_level,approved_at', filters: { approved_at: `gte.${monthStart}T00:00:00-03:00` } }),
    rest.select('proposals', { select: 'id,invoice_access_key,created_at' }),
    rest.select('invoices', { select: 'access_key,captured_at' }),
  ]);
  const keyByProposal = new Map(parseRows(proposals, isProposal, 'proposals').map((p) => [p.id, p.invoice_access_key]));
  const isInvoiceCapture = shaped<{ access_key: string; captured_at: string }>({ access_key: isString, captured_at: isString });
  const capturedBy = new Map(parseRows(invoices, isInvoiceCapture, 'invoices').map((i) => [i.access_key, i.captured_at]));
  return parseRows(approvals, isApproval, 'approvals').flatMap((a) => {
    const key = keyByProposal.get(a.proposal_id);
    const capturedAt = key === undefined ? undefined : capturedBy.get(key);
    if (capturedAt === undefined) return [];
    return [{ capturedAt, decidedAt: a.approved_at, byRule: a.approver_level === 'regra' }];
  });
}

/** #211 AC-4 De onde a proposta tira os horários da linha do tempo. */
export interface TimelineSource {
  find(invoiceAccessKey: string): Promise<TimelineTimes>;
}

export class SupabaseTimelineSource implements TimelineSource {
  constructor(
    private readonly rest: SupabaseRest,
    private readonly dossier: DossierSource,
  ) {}

  async find(key: string): Promise<TimelineTimes> {
    if (!ACCESS_KEY.test(key)) return {};
    const byKey = { invoice_access_key: `eq.${key}` };
    const [invoices, proposals, dock, store, dossier] = await Promise.all([
      this.rest.select('invoices', { select: 'captured_at,checked_at', filters: { access_key: `eq.${key}` } }),
      this.rest.select('proposals', { select: 'id,invoice_access_key,created_at', filters: byKey }),
      this.rest.select('outbox_dock_actions', { select: 'published_at', filters: byKey, order: 'published_at', limit: 1 }),
      this.rest.select('outbox_store_actions', { select: 'published_at', filters: byKey, order: 'published_at', limit: 1 }),
      this.dossier.find(key),
    ]);
    const invoice = invoices[0] === undefined ? null : parseRows(invoices.slice(0, 1), isInvoiceTimes, 'invoices')[0];
    const proposal = proposals[0] === undefined ? null : parseRows(proposals.slice(0, 1), isProposal, 'proposals')[0];
    const approvals = proposal ? await this.rest.select('approvals', { select: 'proposal_id,approver_level,approved_at', filters: { proposal_id: `eq.${proposal.id}` } }) : [];
    const approval = approvals[0] === undefined ? null : parseRows(approvals.slice(0, 1), isApproval, 'approvals')[0];
    const dockAt = dock[0] === undefined ? null : parseRows(dock, isOutbox, 'outbox_dock_actions')[0]?.published_at ?? null;
    const storeAt = store[0] === undefined ? null : parseRows(store, isOutbox, 'outbox_store_actions')[0]?.published_at ?? null;
    return {
      capturedAt: invoice?.captured_at ?? null,
      checkedAt: invoice?.checked_at ?? null,
      proposedAt: proposal?.created_at ?? null,
      dossierAt: dossier?.status === 'ok' ? dossier.generatedAt : null,
      decidedAt: approval?.approved_at ?? null,
      publishedAt: dockAt ?? storeAt,
      publishedTo: dockAt ? 'doca' : storeAt ? 'loja' : null,
    };
  }
}
