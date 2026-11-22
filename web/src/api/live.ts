// #355 O ao vivo no fio: a resposta de `GET /api/ao-vivo` (#354), lida na borda. A tela só recebe o que passou por `parseLive`.
import { ApiError, apiGet } from "./client";

export type LiveActor = "system" | "rule" | "claude" | "engine" | "person";

export interface LiveInvoiceRef {
  access_key: string;
  /** Nulo quando a API não resolveu o número da nota. */
  number: string | null;
}

interface LiveBase {
  /** Instante do passo, em ISO. */
  at: string;
  actor: LiveActor;
  actor_name: string;
  step: string;
}

export interface LiveRunEvent extends LiveBase {
  kind: "run";
  invoice: null;
  status: "ok" | "failed";
}

export interface LiveDecisionEvent extends LiveBase {
  kind: "decision";
  invoice: LiveInvoiceRef;
  mode: "shadow" | "delegated";
}

export interface LiveHumanDecisionEvent extends LiveBase {
  kind: "human_decision";
  invoice: LiveInvoiceRef;
}

/** A união por `kind`: um passo novo (o pedido de devolução automático da #353) é mais um membro, e quebra o `switch` exaustivo onde faltar tratar. */
export type LiveEvent = LiveRunEvent | LiveDecisionEvent | LiveHumanDecisionEvent;

/** Os números do dia que a tela mostra: da API, sem conta no front. */
export interface LiveDayIndicators {
  date: string;
  decided: number;
  byRule: number;
  withoutPersonPct: number | null;
}

export interface LiveBody {
  events: LiveEvent[];
  /** O cursor: o texto exato que a API devolveu, que a tela manda de volta sem mexer. Nulo sem nenhum passo. */
  since: string | null;
  indicators: { day: LiveDayIndicators };
  awaiting: number;
}

/** O corpo não tem a forma do contrato. Sem texto do corpo: a tela mostra só a mensagem dela. */
const malformed = (): ApiError => new ApiError(0, "corpo_inesperado", "a API respondeu fora do contrato");

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const ACTORS: readonly string[] = ["system", "rule", "claude", "engine", "person"];
const isActor = (v: unknown): v is LiveActor => isText(v) && ACTORS.includes(v);

function invoiceOf(v: unknown): LiveInvoiceRef {
  if (!isDict(v) || !isText(v.access_key) || !(v.number === null || isText(v.number))) throw malformed();
  return { access_key: v.access_key, number: v.number };
}

function eventOf(v: unknown): LiveEvent {
  if (!isDict(v) || !isText(v.at) || !isActor(v.actor) || !isText(v.actor_name) || !isText(v.step)) throw malformed();
  const base: LiveBase = { at: v.at, actor: v.actor, actor_name: v.actor_name, step: v.step };
  switch (v.kind) {
    case "run":
      if (v.invoice !== null || (v.status !== "ok" && v.status !== "failed")) throw malformed();
      return { ...base, kind: "run", invoice: null, status: v.status };
    case "decision":
      if (v.mode !== "shadow" && v.mode !== "delegated") throw malformed();
      return { ...base, kind: "decision", invoice: invoiceOf(v.invoice), mode: v.mode };
    case "human_decision":
      return { ...base, kind: "human_decision", invoice: invoiceOf(v.invoice) };
    default:
      throw malformed();
  }
}

function dayOf(v: unknown): LiveDayIndicators {
  if (!isDict(v) || !isText(v.date) || !isCount(v.decided) || !isCount(v.byRule)) throw malformed();
  const pct = v.withoutPersonPct;
  if (pct !== null && !isCount(pct)) throw malformed();
  return { date: v.date, decided: v.decided, byRule: v.byRule, withoutPersonPct: pct };
}

/** Lê o corpo cru na borda; qualquer forma fora do contrato é `ApiError`, e o corpo nunca vai à mensagem. */
export function parseLive(body: unknown): LiveBody {
  if (!isDict(body) || !Array.isArray(body.events) || !isDict(body.indicators) || !isCount(body.awaiting)) throw malformed();
  if (body.since !== null && !isText(body.since)) throw malformed();
  const events: unknown[] = body.events;
  return { events: events.map(eventOf), since: body.since, indicators: { day: dayOf(body.indicators.day) }, awaiting: body.awaiting };
}

export const liveApi = {
  /** `since` é o cursor devolvido, no pedido sem mexer; sem ele, a API traz os últimos passos. */
  load: async (since: string | null, signal: AbortSignal): Promise<LiveBody> => {
    const query = since === null ? "" : `?since=${encodeURIComponent(since)}`;
    return parseLive(await apiGet<unknown>(`/api/ao-vivo${query}`, { signal }));
  },
};
