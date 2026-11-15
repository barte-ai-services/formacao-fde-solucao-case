/** #63 Os nomes e os tons de nível e de ação na doca, como no wireframe aprovado (F3). */
import type { Tone } from "@barte-ai-services/barte-ui-kit";
import type { ApprovalLevel, DockActionDto } from "../api/contract";

export const LEVEL_LABEL: Record<ApprovalLevel, string> = {
  regra: "Regra",
  analista: "Analista",
  coordenacao: "Coordenação",
  diretoria: "Diretoria",
  bloqueio: "Bloqueio",
};

export const LEVEL_TONE: Record<ApprovalLevel, Tone> = {
  regra: "positive",
  analista: "info",
  coordenacao: "neutral",
  diretoria: "waiting",
  bloqueio: "negative",
};

export type DockActionKind = DockActionDto["kind"];

export const ACTION_LABEL: Record<DockActionKind, string> = {
  receber: "Receber",
  receber_parcial: "Receber parcial",
  recusar: "Recusar",
};

export const ACTION_TONE: Record<DockActionKind, Tone> = {
  receber: "positive",
  receber_parcial: "waiting",
  recusar: "negative",
};

/** A ordem da fila: o nível mais alto primeiro, depois o maior valor em risco. */
const RANK: Record<ApprovalLevel, number> = { bloqueio: 4, diretoria: 3, coordenacao: 2, analista: 1, regra: 0 };

export function byQueueOrder(
  a: { level: ApprovalLevel; amountAtRisk: { cents: number } },
  b: { level: ApprovalLevel; amountAtRisk: { cents: number } },
): number {
  return RANK[b.level] - RANK[a.level] || b.amountAtRisk.cents - a.amountAtRisk.cents;
}
