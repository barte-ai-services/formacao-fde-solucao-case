/**
 * #203 O que a lista do receber parcial traz já preenchido: a diferença que a evidência de cada divergência mostra,
 * e o destino que a regra propõe para aquela exceção (só o E3 devolve a diferença; as demais seguram o item).
 */
import type { ProposalDetailDto } from "../api/approval";

export type Disposition = "segurar" | "devolver";
export type PartialInput = { amount: string; disposition: Disposition };

/** Só o E3 devolve, e só a diferença; E1, E2 e as outras seguram o item inteiro (draft-checked.ts na API). */
const RETURNS: readonly string[] = ["E3"];
/** E3 gera "Contado 7 UN de 10 UN: Arroz 5kg": a diferença é o faturado menos o contado. */
const COUNTED = /^Contado ([\d.]+) \S+ de ([\d.]+) \S+: (.+)$/;

export function partialPrefill(proposal: ProposalDetailDto): Record<string, PartialInput> {
  const out: Record<string, PartialInput> = {};
  for (const d of proposal.divergences) {
    for (const sku of d.skus) {
      const item = proposal.items.find((i) => (i.sku ?? i.supplierCode) === sku);
      if (!item || out[sku]) continue;
      let amount = item.quantity.amount;
      if (d.classification === "E3") {
        for (const e of d.evidence) {
          const m = COUNTED.exec(e.description);
          // Arredonda: 1,5 − 1,2 não pode virar 0.30000000000000004 no campo.
          if (m && m[3] === item.description) amount = Math.round((Number(m[2]) - Number(m[1])) * 1000) / 1000;
        }
      }
      out[sku] = { amount: String(amount), disposition: RETURNS.includes(d.classification) ? "devolver" : "segurar" };
    }
  }
  return out;
}
