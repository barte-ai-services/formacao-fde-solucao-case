// #354 Os passos da automação que a tela Ao vivo mostra: a rodada, a decisão da regra ou do motor e a decisão de pessoa.
import type { AutomationRun } from './runs.js';
import type { Indicators } from './indicators.js';
import type { AutoReturnSent, InvoiceRef, PersonApproval } from './readers.js';
import type { TimelineActor } from './timeline.js';
import type { StoredDecision } from '../engine/decision.js';

/** #354 O que todo passo traz. `invoice` é a nota que a gaveta abre (nula na rodada, que não tem nota). */
type LiveBase = {
  /** #354 Instante do passo, em ISO. */
  at: string;
  actor: TimelineActor;
  actor_name: string;
  invoice: InvoiceRef | null;
  /** #354 Texto curto do passo, em português. */
  step: string;
};

/** #354 A rodada do Cron: sem nota. */
export type LiveRunEvent = LiveBase & { kind: 'run'; invoice: null; status: AutomationRun['status'] };
/** #354 A decisão da regra ou do motor, em sombra (o que faria) ou delegada (o que fez). */
export type LiveDecisionEvent = LiveBase & { kind: 'decision'; invoice: InvoiceRef; mode: StoredDecision['mode'] };
/** #354 A decisão de uma pessoa. */
export type LiveHumanDecisionEvent = LiveBase & { kind: 'human_decision'; invoice: InvoiceRef };

/** #353 O pedido de devolução que a automação emitiu e enviou sozinha (modo demonstração, valor até o limite do banco). */
export type LiveAutoReturnEvent = LiveBase & { kind: 'auto_return'; invoice: InvoiceRef };

/** #354 A união por `kind`. Um passo novo entra como mais um membro (o da #353 é o `auto_return`). */
export type LiveEvent = LiveRunEvent | LiveDecisionEvent | LiveHumanDecisionEvent | LiveAutoReturnEvent;

/** #354 A resposta de `GET /api/live`. `since` é o cursor: o instante, no texto do banco, do passo mais novo, que a tela devolve no próximo pedido. */
export type LiveBody = {
  events: LiveEvent[];
  since: string | null;
  /** #354 O que `computeIndicators` devolve, sem recalcular. */
  indicators: Indicators;
  /** #354 As propostas que esperam uma pessoa: o `total` da fila de aprovação. */
  awaiting: number;
};

/** #354 O teto de passos por resposta: a tela busca a cada poucos segundos. */
export const LIVE_LIMIT = 50;

const KIND_RANK: Record<LiveEvent['kind'], number> = { human_decision: 0, decision: 1, auto_return: 2, run: 3 };

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

/** #353 O pedido enviado sozinho: o selo é o da automação (`system`, "Automático"), o mesmo da rodada, e o texto diz o que houve. */
export function autoReturnEvent(sent: AutoReturnSent, invoice: InvoiceRef): LiveAutoReturnEvent | null {
  const at = iso(sent.sentAt);
  if (at === null) return null;
  return { kind: 'auto_return', at, actor: 'system', actor_name: 'Automático', invoice, step: 'Enviado automaticamente' };
}

/** #354 Um passo com o instante do banco, no texto original (microssegundos e fuso), de onde sai o cursor. */
export type Stamped = { readonly event: LiveEvent; readonly raw: string };

/** #354 Uma fonte lida de `since` para a frente: os passos e o `horizon`, o instante da última linha quando a leitura voltou cheia. */
export type Source = { readonly steps: readonly Stamped[]; readonly horizon: string | null };

/** #354 O instante em microssegundos: `Date.parse` só guarda milissegundos, e o banco compara com os seis dígitos. */
export function microseconds(raw: string): number {
  const sub = Number((/\.(\d+)/.exec(raw)?.[1] ?? '').padEnd(6, '0').slice(3, 6));
  return Date.parse(raw.replace(/(\.\d{3})\d+/, '$1')) * 1000 + sub;
}

const newestFirstOrder = (a: Stamped, b: Stamped): number =>
  microseconds(b.raw) - microseconds(a.raw) ||
  KIND_RANK[a.event.kind] - KIND_RANK[b.event.kind] ||
  (a.event.invoice?.access_key ?? '').localeCompare(b.event.invoice?.access_key ?? '');

/**
 * #354 Os passos mais novos, do mais novo ao mais velho, no máximo `limit`, sem `since`. O empate no instante sai sempre
 * igual: a decisão de pessoa, a da cascata, a rodada, e depois a chave da nota. O cursor é o texto do banco do mais novo.
 */
export function newest(found: readonly Stamped[], limit: number): { events: LiveEvent[]; since: string | null } {
  const top = [...found].sort(newestFirstOrder).slice(0, limit);
  return { events: top.map((s) => s.event), since: top[0]?.raw ?? null };
}

/**
 * #354 O próximo lote de quem já tem passos até `since`: cada fonte foi lida do mais velho para o mais novo, então o lote
 * são os `limit` mais velhos de todas e o atraso esvazia consulta a consulta, sem buraco. O lote sai do mais novo ao mais
 * velho e o cursor é o instante do mais novo dele, no texto do banco (nunca arredondado em milissegundos), que o banco
 * compara com `gt.` nos mesmos microssegundos: nem pula quem divide o milissegundo do cursor, nem repete o do cursor.
 * Duas regras fecham as bordas. (1) Os passos que dividem o instante do último do lote entram todos, mesmo passando de
 * `limit`, porque o cursor depois dele os pularia. (2) Uma fonte que voltou cheia pode ter mais linhas no instante da
 * última lida, então só entra o que é estritamente antes do menor `horizon`; o resto vem na consulta seguinte. Se nada
 * é antes (mais de `limit` linhas no mesmo microssegundo), entra até o `horizon`: o cursor precisa andar.
 */
export function drain(sources: readonly Source[], limit: number, since: string): { events: LiveEvent[]; since: string } {
  const horizons = sources.flatMap((s) => (s.horizon === null ? [] : [microseconds(s.horizon)]));
  const ceiling = horizons.length === 0 ? Infinity : Math.min(...horizons);
  const ascending = sources.flatMap((s) => s.steps).sort((a, b) => microseconds(a.raw) - microseconds(b.raw));
  const before = ascending.filter((s) => microseconds(s.raw) < ceiling);
  const pool = before.length > 0 ? before : ascending.filter((s) => microseconds(s.raw) <= ceiling);
  const cut = pool[Math.min(limit, pool.length) - 1];
  if (cut === undefined) return { events: [], since };
  const batch = pool.filter((s) => microseconds(s.raw) <= microseconds(cut.raw)).sort(newestFirstOrder);
  return { events: batch.map((s) => s.event), since: batch[0]?.raw ?? since };
}
