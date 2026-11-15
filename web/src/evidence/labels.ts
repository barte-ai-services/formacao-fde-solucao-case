import type { DivergenceCode, EvidenceSource } from "../api/contract";
import { texts } from "../texts";

/** O nome de cada exceção, como no wireframe aprovado (F3). */
export const DIVERGENCE_LABEL: Record<DivergenceCode, string> = texts.exception;

/** O sistema de onde vem cada evidência. */
export const SOURCE_LABEL: Record<EvidenceSource, string> = texts.source;

export function divergenceLabel(code: string): string {
  return Object.hasOwn(DIVERGENCE_LABEL, code) ? DIVERGENCE_LABEL[code as DivergenceCode] : code;
}

export function sourceLabel(source: string): string {
  return Object.hasOwn(SOURCE_LABEL, source) ? SOURCE_LABEL[source as EvidenceSource] : source;
}
