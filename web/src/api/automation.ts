// #211 A automação no fio: a resposta de `GET /api/automacao`. Os números vêm da API, nunca da tela.
import { apiGet } from "./client";

export interface RunFiguresDto {
  seen: number;
  inserted: number;
  checked: number;
  failed: number;
  proposed: number;
  approvedByRule: number;
  cadastroE8: number;
  dockPublished: number;
  storePublished: number;
  duplicatesBlocked: number;
}

export interface AutomationRunDto {
  id: number;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "failed";
  figures: RunFiguresDto;
  error: string | null;
}

export interface PeriodIndicatorsDto {
  decided: number;
  byRule: number;
  withoutPersonPct: number | null;
  medianSeconds: { withoutPerson: number | null; withPerson: number | null };
}

export interface AutomationDto {
  state: "ok" | "failed" | "stalled";
  last: AutomationRunDto | null;
  next: string;
  runs: AutomationRunDto[];
  indicators: {
    day: PeriodIndicatorsDto & { date: string };
    month: PeriodIndicatorsDto & { month: string };
  };
}

export const loadAutomation = (signal?: AbortSignal) => apiGet<AutomationDto>("/api/automacao", { signal });
