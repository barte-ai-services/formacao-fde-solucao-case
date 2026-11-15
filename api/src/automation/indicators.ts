// #211 AC-5 Os indicadores, calculados na API: % resolvido sem pessoa e mediana da captura à decisão.
import { todayInBrasilia } from '../http/approval.js';

export type DecisionRecord = { readonly capturedAt: string; readonly decidedAt: string; readonly byRule: boolean };

export type PeriodIndicators = {
  decided: number;
  byRule: number;
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
  const rule = records.filter((r) => r.byRule);
  return {
    decided: records.length,
    byRule: rule.length,
    withoutPersonPct: records.length === 0 ? null : Math.round((rule.length / records.length) * 100),
    medianSeconds: {
      withoutPerson: median(rule.map(seconds)),
      withPerson: median(records.filter((r) => !r.byRule).map(seconds)),
    },
  };
}

/** #211 O dia e o mês correntes, no fuso de Brasília, onde a Já Chegou paga. */
export function computeIndicators(records: readonly DecisionRecord[], now: Date) {
  const date = todayInBrasilia(now);
  const month = date.slice(0, 7);
  const inDay = records.filter((r) => todayInBrasilia(new Date(r.decidedAt)) === date);
  const inMonth = records.filter((r) => todayInBrasilia(new Date(r.decidedAt)).startsWith(month));
  return { day: { date, ...period(inDay) }, month: { month, ...period(inMonth) } };
}
