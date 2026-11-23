// #211 A automação no fio: a resposta de `GET /api/automacao`. Os números vêm da API, nunca da tela.
import { apiGet, apiPost } from "./client";

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

/** #357 Uma rodada pulada (a trava estava tomada). Vem de `skipped` em `GET /api/automacao`. */
export interface SkippedRunDto {
  id: number;
  startedAt: string;
  origin: "cron" | "manual";
  demoEnabled: boolean;
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
  /** #357 Acrescentados pela API (#356): opcionais, a faixa também lê a resposta de antes deles. */
  demo?: { enabled: boolean; changedAt: string | null };
  intervalMinutes?: number;
  skipped?: SkippedRunDto[];
  /** Quem pede é administrador: só então a faixa mostra "Rodar agora" e o liga/desliga. */
  isAdmin?: boolean;
}

export const loadAutomation = (signal?: AbortSignal) => apiGet<AutomationDto>("/api/automacao", { signal });

/** #357 AC-2 `POST /api/admin/rodar-agora`: 202, a rodada corre depois da resposta. */
export const runNow = (signal?: AbortSignal) => apiPost<{ accepted: boolean; origin: "manual" }>("/api/admin/rodar-agora", {}, { signal });

/** #357 AC-2 `POST /api/admin/modo-demonstracao`: o corpo é exatamente `{ enabled }`. */
export const setDemoMode = (enabled: boolean, signal?: AbortSignal) =>
  apiPost<unknown>("/api/admin/modo-demonstracao", { enabled }, { signal });
