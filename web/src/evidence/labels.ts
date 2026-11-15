import type { EvidenceSource } from "../api/contract";
import { texts } from "../texts";

/** O sistema de onde vem cada evidência. */
export const SOURCE_LABEL: Record<EvidenceSource, string> = texts.source;

export function sourceLabel(source: string): string {
  return Object.hasOwn(SOURCE_LABEL, source) ? SOURCE_LABEL[source as EvidenceSource] : source;
}
