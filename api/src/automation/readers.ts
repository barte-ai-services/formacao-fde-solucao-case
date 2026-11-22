// #211 O que a API lê do banco para a faixa, os indicadores e a linha do tempo. Só leitura.
import { isInteger, isString, nullable, oneOf, optional, parseRows, shaped, type Shape } from '../connectors/guards.js';
import { ENGINE_APPROVER } from '../domain/approval.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import type { DossierSource } from '../dossier/source.js';
import { computeIndicators, type DecidedBy, type DecisionRecord, type Indicators } from './indicators.js';
import { todayInBrasilia } from '../http/approval.js';
import type { TimelineTimes } from './timeline.js';

const ACCESS_KEY = /^[A-Za-z0-9-]+$/;

type InvoiceTimes = { captured_at: string; checked_at: string | null };
type ProposalRow = { id: number; invoice_access_key: string; created_at: string };
type ApprovalRow = { proposal_id: number; approver_level: string; approved_at: string };
type OutboxRow = { published_at: string };
// #42 A aprovação lida para os indicadores: `approved_by` é a coluna gerada da migração do motor; `approver` serve
// #42 ao recuo quando ela não vem (banco sem a migração).
type DecisionApprovalRow = {
  proposal_id: number;
  approver: string;
  approver_level: string;
  approved_at: string;
  approved_by?: DecidedBy | undefined;
};

const isInvoiceTimes = shaped<InvoiceTimes>({ captured_at: isString, checked_at: nullable(isString) } satisfies Shape<InvoiceTimes>);
const isProposal = shaped<ProposalRow>({ id: isInteger, invoice_access_key: isString, created_at: isString } satisfies Shape<ProposalRow>);
const isApproval = shaped<ApprovalRow>({ proposal_id: isInteger, approver_level: isString, approved_at: isString } satisfies Shape<ApprovalRow>);
const isDecisionApproval = shaped<DecisionApprovalRow>({
  proposal_id: isInteger,
  approver: isString,
  approver_level: isString,
  approved_at: isString,
  approved_by: optional(oneOf('rule', 'engine', 'person')),
} satisfies Shape<DecisionApprovalRow>);
const isOutbox = shaped<OutboxRow>({ published_at: isString } satisfies Shape<OutboxRow>);

/** #42 Quem decidiu: a coluna `approved_by` quando existe; sem ela, o nível regra, o aprovador do motor ou a pessoa. */
export function decidedBy(a: Pick<DecisionApprovalRow, 'approver' | 'approver_level' | 'approved_by'>): DecidedBy {
  if (a.approved_by !== undefined) return a.approved_by;
  if (a.approver_level === 'regra') return 'rule';
  return a.approver === ENGINE_APPROVER ? 'engine' : 'person';
}

/** #211 AC-5 Todas as decisões, com a captura da nota, para os indicadores. */
/** #211 Lê só as decisões do mês corrente (Brasília, UTC-3); os indicadores não usam mais que isso. */
export async function readDecisionRecords(rest: SupabaseRest, monthStart: string): Promise<DecisionRecord[]> {
  const [approvals, proposals, invoices] = await Promise.all([
    // #42 `*` em vez da lista de colunas: num banco sem a migração do motor, pedir `approved_by` seria erro 400.
    rest.select('approvals', { select: '*', filters: { approved_at: `gte.${monthStart}T00:00:00-03:00` } }),
    rest.select('proposals', { select: 'id,invoice_access_key,created_at' }),
    rest.select('invoices', { select: 'access_key,captured_at' }),
  ]);
  const keyByProposal = new Map(parseRows(proposals, isProposal, 'proposals').map((p) => [p.id, p.invoice_access_key]));
  const isInvoiceCapture = shaped<{ access_key: string; captured_at: string }>({ access_key: isString, captured_at: isString });
  const capturedBy = new Map(parseRows(invoices, isInvoiceCapture, 'invoices').map((i) => [i.access_key, i.captured_at]));
  return parseRows(approvals, isDecisionApproval, 'approvals').flatMap((a) => {
    const key = keyByProposal.get(a.proposal_id);
    const capturedAt = key === undefined ? undefined : capturedBy.get(key);
    if (capturedAt === undefined) return [];
    return [{ capturedAt, decidedAt: a.approved_at, by: decidedBy(a) }];
  });
}

/** #211 Os indicadores do dia e do mês, da rodada e da lista: a mesma leitura para `/api/automacao` e `/api/ao-vivo` (#354). */
export async function readIndicators(rest: SupabaseRest, now: Date): Promise<Indicators> {
  return computeIndicators(await readDecisionRecords(rest, `${todayInBrasilia(now).slice(0, 7)}-01`), now);
}

/** #354 Uma aprovação de pessoa. */
export type PersonApproval = { readonly proposalId: number; readonly approver: string; readonly approvedAt: string };

/** #354 A leitura das aprovações de pessoa e o `horizon` dela: ver `Page` em live.ts. */
export type PersonApprovalsRead = { readonly approvals: PersonApproval[]; readonly horizon: string | null };

/**
 * #354 As aprovações em que uma pessoa decidiu (nem a regra, nem o motor), depois de `afterIso` quando vem, do mais novo
 * ao mais velho (`desc`) ou do mais velho ao mais novo (`asc`, para a tela esvaziar o atraso). O filtro de quem decidiu
 * vai na consulta; `decidedBy` confere de novo, com a coluna `approved_by` quando ela existe. O `horizon` é o instante da
 * última linha lida quando a consulta voltou cheia (pode haver mais atrás dele), senão nulo.
 */
export async function readPersonApprovals(
  rest: SupabaseRest,
  limit: number,
  afterIso?: string,
  direction: 'asc' | 'desc' = 'desc',
): Promise<PersonApprovalsRead> {
  const rows = parseRows(
    await rest.select('approvals', {
      select: '*',
      filters: { approver_level: 'neq.regra', approver: `neq.${ENGINE_APPROVER}`, ...(afterIso !== undefined && { approved_at: `gt.${afterIso}` }) },
      order: `approved_at.${direction}`,
      limit,
    }),
    isDecisionApproval,
    'approvals',
  );
  return {
    approvals: rows.filter((a) => decidedBy(a) === 'person').map((a) => ({ proposalId: a.proposal_id, approver: a.approver, approvedAt: a.approved_at })),
    horizon: rows.length === limit ? (rows.at(-1)?.approved_at ?? null) : null,
  };
}

/** #354 A nota que o passo cita: a chave de acesso (por onde a gaveta abre) e o número, quando a nota está no banco. */
export type InvoiceRef = { readonly access_key: string; readonly number: string | null };

/** #354 As notas dos passos, de uma vez: pela chave de acesso e pelo id da proposta. A chave fora do formato fica de fora. */
export async function readInvoiceRefs(
  rest: SupabaseRest,
  keys: readonly string[],
  proposalIds: readonly number[],
): Promise<{ byKey: Map<string, InvoiceRef>; byProposal: Map<number, InvoiceRef> }> {
  const proposals =
    proposalIds.length === 0
      ? []
      : parseRows(
          await rest.select('proposals', { select: 'id,invoice_access_key', filters: { id: `in.(${[...new Set(proposalIds)].join(',')})` } }),
          shaped<{ id: number; invoice_access_key: string }>({ id: isInteger, invoice_access_key: isString }),
          'proposals',
        );
  const keyOf = new Map(proposals.map((p) => [p.id, p.invoice_access_key]));
  const all = [...new Set([...keys, ...keyOf.values()])].filter((k) => ACCESS_KEY.test(k));
  const invoices =
    all.length === 0
      ? []
      : parseRows(
          await rest.select('invoices', { select: 'access_key,number', filters: { access_key: `in.(${all.map((k) => `"${k}"`).join(',')})` } }),
          shaped<{ access_key: string; number: string }>({ access_key: isString, number: isString }),
          'invoices',
        );
  const numbers = new Map(invoices.map((i) => [i.access_key, i.number]));
  const refOf = (key: string): InvoiceRef => ({ access_key: key, number: numbers.get(key) ?? null });
  return {
    byKey: new Map(all.map((k) => [k, refOf(k)])),
    byProposal: new Map([...keyOf].filter(([, k]) => ACCESS_KEY.test(k)).map(([id, k]) => [id, refOf(k)])),
  };
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
