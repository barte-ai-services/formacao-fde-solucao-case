/** #63 Os nomes e os tons de nível e de ação na doca, como no wireframe aprovado (F3). */
import type { Tone } from "@barte-ai-services/barte-ui-kit";
import type { ApprovalLevel, Classification, DockActionDto } from "../api/contract";
import { texts } from "../texts";

export const LEVEL_LABEL: Record<ApprovalLevel, string> = texts.level;

export const LEVEL_TONE: Record<ApprovalLevel, Tone> = {
  regra: "positive",
  analista: "info",
  coordenacao: "neutral",
  diretoria: "waiting",
  bloqueio: "negative",
};

export type DockActionKind = DockActionDto["kind"];

export const ACTION_LABEL: Record<DockActionKind, string> = texts.action;

export const ACTION_TONE: Record<DockActionKind, Tone> = {
  receber: "positive",
  receber_parcial: "waiting",
  recusar: "negative",
};

/** #201 AC3: a coluna "Código" da fila e da lista do dia. MATCH não é código de exceção: aparece como traço. */
export function codeLabel(code: Classification): string {
  return code === "MATCH" ? "—" : code;
}
