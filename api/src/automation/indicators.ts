// #211 AC-5 Os indicadores, calculados na API: % resolvido sem pessoa e mediana da captura à decisão.
// #42 Sem pessoa é a regra ou o motor; `byRule` segue só com a regra e `byEngine` conta o motor.
import { todayInBrasilia } from '../http/approval.js';

/** #42 Quem decidiu: a regra, o motor (modo delegado) ou uma pessoa. Regra e motor são "sem pessoa". */
export type DecidedBy = 'rule' | 'engine' | 'person';

export type DecisionRecord = { readonly capturedAt: string; readonly decidedAt: string; readonly by: DecidedBy };

export type PeriodIndicators = {
  decided: number;
  byRule: number;
  byEngine: number;
  withoutPersonPct: number | null;
  medianSeconds: { withoutPerson: number | null; withPerson: number | null };
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return Math.round(value);
}

function period(records: readonly DecisionRecord[]): PeriodIndicators {
  const seconds = (r: DecisionRecord) => Math.max(0, (Date.parse(r.decidedAt) - Date.parse(r.capturedAt)) / 1000);
  const withoutPerson = records.filter((r) => r.by !== 'person');
  return {
    decided: records.length,
    byRule: records.filter((r) => r.by === 'rule').length,
    byEngine: records.filter((r) => r.by === 'engine').length,
    withoutPersonPct: records.length === 0 ? null : Math.round((withoutPerson.length / records.length) * 100),
    medianSeconds: {
      withoutPerson: median(withoutPerson.map(seconds)),
      withPerson: median(records.filter((r) => r.by === 'person').map(seconds)),
    },
  };
}

/** #354 O que `computeIndicators` devolve: o dia e o mês, cada um com a sua chave de período. */
export type Indicators = {
  day: { date: string } & PeriodIndicators;
  month: { month: string } & PeriodIndicators;
};

/** #211 O dia e o mês correntes, no fuso de Brasília, onde a Já Chegou paga. */
export function computeIndicators(records: readonly DecisionRecord[], now: Date): Indicators {
  const date = todayInBrasilia(now);
  const month = date.slice(0, 7);
  const inDay = records.filter((r) => todayInBrasilia(new Date(r.decidedAt)) === date);
  const inMonth = records.filter((r) => todayInBrasilia(new Date(r.decidedAt)).startsWith(month));
  return { day: { date, ...period(inDay) }, month: { month, ...period(inMonth) } };
}
