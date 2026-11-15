// Valor barrado no mês contra a linha de base de R$ 543 mil (#71, história #39). Função pura, sem rede.
import { Money } from '../domain/money.js';
import { PRECEDENCE, type Classification } from '../domain/classification.js';
import type { DockAction } from '../domain/dock-action.js';
import type { ProposalState } from '../domain/proposal.js';

/** #71/AC-2: o que a Já Chegou pagava por mês sem a mercadoria, em centavos. */
export const BASELINE_CENTS = 54_300_000;

/** #71: Brasília em UTC-3 fixo, sem horário de verão. */
const BRASILIA_OFFSET_MS = -3 * 60 * 60 * 1000;

export type Month = { readonly year: number; readonly month: number };

/** #71: a proposta como o painel precisa dela, já juntada com a data da aprovação (se houver). */
export type ProposalRecord = {
  readonly id: number;
  readonly classification: Classification;
  /** Ação vigente: em `alterada`, a que a pessoa gravou. */
  readonly dockActionKind: DockAction['kind'];
  readonly amountAtRiskCents: number;
  readonly state: ProposalState;
  readonly createdAt: string;
  /** `approvals.approved_at`; null quando a aprovação foi pela regra, sem linha em approvals. */
  readonly approvedAt: string | null;
};

export type ExceptionTotal = { readonly classification: Classification; readonly cents: number; readonly count: number };
export type Breakdown = { readonly totalCents: number; readonly byException: readonly ExceptionTotal[] };
export type DailyPoint = {
  readonly day: string;
  readonly barredCumulativeCents: number;
  readonly proposedCumulativeCents: number;
};

export type BarredAmountPanel = {
  readonly month: string;
  readonly baselineCents: number;
  /** #71/AC-1, AC-3: decididas no mês com a ação recusar ou receber parcial. */
  readonly barred: Breakdown;
  /** Decisão do Tech Lead: aguardando aprovação, criadas no mês, se aprovadas como propostas. */
  readonly ifApprovedAsProposed: Breakdown;
  readonly daily: readonly DailyPoint[];
};

export type BarredAmountSummary = {
  readonly panel: BarredAmountPanel;
  /** MATCH nunca deveria barrar; se aparecer, fica de fora da soma e o chamador registra. */
  readonly ignoredMatchProposalIds: readonly number[];
};

const BARRING_ACTIONS: ReadonlySet<DockAction['kind']> = new Set(['recusar', 'receber_parcial']);
const DECIDED: ReadonlySet<ProposalState> = new Set(['aprovada', 'alterada']);

/** #71: `AAAA-MM` com mês de 01 a 12; qualquer outra coisa é null. */
export function parseMonth(value: string): Month | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/** #71: o mês corrente no fuso de Brasília. */
export function currentMonth(now: Date): Month {
  return monthOfMs(now.getTime());
}

/** #71: o mês de um instante ISO no fuso de Brasília. */
export function monthOf(instant: string): Month {
  return monthOfMs(toMs(instant));
}

export function formatMonth({ year, month }: Month): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function summarizeBarredAmount(records: readonly ProposalRecord[], month: Month): BarredAmountSummary {
  const barred: Event[] = [];
  const proposed: Event[] = [];
  const ignoredMatchProposalIds: number[] = [];

  for (const record of records) {
    if (!BARRING_ACTIONS.has(record.dockActionKind)) continue;
    const kind = DECIDED.has(record.state) ? 'barred' : record.state === 'aguardando_aprovacao' ? 'proposed' : null;
    if (!kind) continue;
    // #71/AC-3: decidida conta pela data da decisão; aguardando, pela de criação.
    const instant = kind === 'barred' ? (record.approvedAt ?? record.createdAt) : record.createdAt;
    const ms = toMs(instant);
    if (!sameMonth(monthOfMs(ms), month)) continue;
    if (record.classification === 'MATCH') {
      ignoredMatchProposalIds.push(record.id);
      continue;
    }
    const event = { classification: record.classification, cents: record.amountAtRiskCents, day: dayOfMs(ms) };
    (kind === 'barred' ? barred : proposed).push(event);
  }

  return {
    panel: {
      month: formatMonth(month),
      baselineCents: BASELINE_CENTS,
      barred: breakdown(barred),
      ifApprovedAsProposed: breakdown(proposed),
      daily: daily(barred, proposed),
    },
    ignoredMatchProposalIds,
  };
}

type Event = { readonly classification: Classification; readonly cents: number; readonly day: string };

function breakdown(events: readonly Event[]): Breakdown {
  const byException: ExceptionTotal[] = [];
  let total = Money.zero();
  for (const classification of PRECEDENCE) {
    const mine = events.filter((e) => e.classification === classification);
    if (mine.length === 0) continue;
    const cents = sum(mine);
    total = total.add(cents);
    byException.push({ classification, cents: cents.cents, count: mine.length });
  }
  return { totalCents: total.cents, byException };
}

function daily(barred: readonly Event[], proposed: readonly Event[]): DailyPoint[] {
  const days = [...new Set([...barred, ...proposed].map((e) => e.day))].sort();
  let barredSoFar = Money.zero();
  let proposedSoFar = Money.zero();
  return days.map((day) => {
    barredSoFar = barredSoFar.add(sum(barred.filter((e) => e.day === day)));
    proposedSoFar = proposedSoFar.add(sum(proposed.filter((e) => e.day === day)));
    return { day, barredCumulativeCents: barredSoFar.cents, proposedCumulativeCents: proposedSoFar.cents };
  });
}

function sum(events: readonly Event[]): Money {
  return events.reduce((acc, e) => acc.add(Money.ofCents(e.cents)), Money.zero());
}

function toMs(instant: string): number {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`valor barrado: instante inválido ${JSON.stringify(instant)}`);
  return ms;
}

function brasilia(ms: number): Date {
  return new Date(ms + BRASILIA_OFFSET_MS);
}

function monthOfMs(ms: number): Month {
  const local = brasilia(ms);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1 };
}

function dayOfMs(ms: number): string {
  return brasilia(ms).toISOString().slice(0, 10);
}

function sameMonth(a: Month, b: Month): boolean {
  return a.year === b.year && a.month === b.month;
}
