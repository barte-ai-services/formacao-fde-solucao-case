// #354 Os passos da automação que a tela Ao vivo mostra: a rodada, a decisão da regra ou do motor e a decisão de pessoa.
import type { AutomationRun } from './runs.js';
import type { InvoiceRef, PersonApproval } from './readers.js';
import type { TimelineActor } from './timeline.js';
import type { StoredDecision } from '../engine/decision.js';

/** #354 O que todo passo traz. `invoice` é a nota que a gaveta abre (nula na rodada, que não tem nota). */
type LiveBase = {
  /** Instante do passo, em ISO. */
  at: string;
  actor: TimelineActor;
  actor_name: string;
  invoice: InvoiceRef | null;
  /** Texto curto do passo, em português. */
  step: string;
};

/** #354 A rodada do Cron: sem nota. */
export type LiveRunEvent = LiveBase & { kind: 'run'; invoice: null; status: AutomationRun['status'] };
/** #354 A decisão da regra ou do motor, em sombra (o que faria) ou delegada (o que fez). */
export type LiveDecisionEvent = LiveBase & { kind: 'decision'; invoice: InvoiceRef; mode: StoredDecision['mode'] };
/** #354 A decisão de uma pessoa. */
export type LiveHumanDecisionEvent = LiveBase & { kind: 'human_decision'; invoice: InvoiceRef };

/** #354 A união por `kind`. Um passo novo (ex.: o pedido de devolução automático da #353) entra como mais um membro. */
export type LiveEvent = LiveRunEvent | LiveDecisionEvent | LiveHumanDecisionEvent;

/** #354 A resposta de `GET /api/ao-vivo`. `since` é o cursor: o `at` do passo mais novo, que a tela devolve no próximo pedido. */
export type LiveBody = {
  events: LiveEvent[];
  since: string | null;
  /** #354 O que `computeIndicators` devolve, sem recalcular. */
  indicators: {
    day: { date: string } & Record<string, unknown>;
    month: { month: string } & Record<string, unknown>;
  };
  /** #354 As propostas que esperam uma pessoa: o `total` da fila de aprovação. */
  awaiting: number;
};

/** #354 O teto de passos por resposta: a tela busca a cada poucos segundos. */
export const LIVE_LIMIT = 50;

const KIND_RANK: Record<LiveEvent['kind'], number> = { human_decision: 0, decision: 1, run: 2 };

const iso = (value: string): string | null => {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

export function runEvent(run: AutomationRun): LiveRunEvent | null {
  const at = iso(run.startedAt);
  if (at === null) return null;
  const f = run.figures;
  return {
    kind: 'run',
    at,
    actor: 'system',
    actor_name: 'Automático',
    invoice: null,
    status: run.status,
    step: run.status === 'ok' ? `Rodada: ${f.seen} vistas, ${f.proposed} propostas, ${f.approvedByRule} pela regra` : `Rodada falhou: ${run.error ?? 'erro'}`,
  };
}

const OUTCOME: Record<StoredDecision['outcome'], { shadow: string; delegated: string }> = {
  approve: { shadow: 'aprovaria', delegated: 'aprovou' },
  refuse: { shadow: 'recusaria', delegated: 'recusou' },
  pending: { shadow: 'deixaria para a pessoa', delegated: 'deixou para a pessoa' },
};

/** #354 A linha da cascata que a pessoa já decidiu (`decided_by = person`) não vira passo aqui: está em approvals. */
export function decisionEvent(d: StoredDecision, invoice: InvoiceRef): LiveDecisionEvent | null {
  const at = iso(d.decidedAt);
  if (at === null || d.decidedBy === 'person') return null;
  const engine = d.decidedBy === 'clef';
  const name = engine ? 'Motor' : 'Regra';
  const verb = OUTCOME[d.outcome][d.mode];
  return {
    kind: 'decision',
    at,
    actor: engine ? 'engine' : 'rule',
    actor_name: name,
    invoice,
    mode: d.mode,
    step: d.mode === 'shadow' ? `${name}, em sombra, ${verb}` : `${name} ${verb}`,
  };
}

export function humanDecisionEvent(a: PersonApproval, invoice: InvoiceRef): LiveHumanDecisionEvent | null {
  const at = iso(a.approvedAt);
  if (at === null) return null;
  return { kind: 'human_decision', at, actor: 'person', actor_name: a.approver, invoice, step: 'Decidiu a proposta' };
}

/**
 * #354 Os passos juntos, do mais novo ao mais velho, no máximo `limit`. O empate na hora sai sempre igual: a decisão de
 * pessoa, a da cascata, a rodada, e depois a chave da nota. Com `since`, só o que é estritamente depois dele: o banco
 * guarda microssegundos e o cursor leva milissegundos, então o filtro em memória evita repetir o passo do próprio cursor.
 */
export function newestFirst(events: readonly LiveEvent[], limit: number, since: string | null): LiveEvent[] {
  const after = since === null ? -Infinity : Date.parse(since);
  return events
    .filter((e) => Date.parse(e.at) > after)
    .sort(
      (a, b) =>
        Date.parse(b.at) - Date.parse(a.at) ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        (a.invoice?.access_key ?? '').localeCompare(b.invoice?.access_key ?? ''),
    )
    .slice(0, limit);
}
