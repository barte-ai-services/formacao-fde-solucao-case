/**
 * #203 O que a lista do receber parcial traz já preenchido: a diferença que a evidência de cada divergência mostra,
 * e o destino que a regra propõe para aquela exceção (E3 e a falta devolvem; as demais seguram até acertar).
 */
import type { ProposalDetailDto } from "../api/approval";

export type Disposition = "segurar" | "devolver";
export type PartialInput = { amount: string; disposition: Disposition };

/** E1 (falta) e E2 (item trocado) devolvem o item; E3 devolve só a diferença; as outras seguram. */
const RETURNS: readonly string[] = ["E1", "E2", "E3"];
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
          if (m && m[3] === item.description) amount = Number(m[2]) - Number(m[1]);
        }
      }
      out[sku] = { amount: String(amount), disposition: RETURNS.includes(d.classification) ? "devolver" : "segurar" };
    }
  }
  return out;
}
