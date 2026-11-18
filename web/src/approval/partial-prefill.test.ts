import { describe, expect, it } from "vitest";
import { partialPrefill } from "./partial-prefill";
import type { ProposalDetailDto } from "../api/approval";

// #203/AC-2 A lista do receber parcial já vem preenchida com a diferença que a evidência mostra.
const item = (sku: string, description: string, amount: number, unit = "UN") => ({ supplierCode: sku, sku, description, quantity: { amount, unit } });
const make = (divergences: unknown[], items = [item("S1", "Arroz 5kg", 10), item("S2", "Feijão 1kg", 5, "CX")]) =>
  ({ items, divergences }) as unknown as ProposalDetailDto;

describe("partialPrefill", () => {
  it("E3: a diferença da contagem, devolvendo", () => {
    const p = make([{ classification: "E3", skus: ["S1"], evidence: [{ source: "wms", reference: "r", description: "Contado 7 UN de 10 UN: Arroz 5kg" }] }]);
    expect(partialPrefill(p)).toEqual({ S1: { amount: "3", disposition: "devolver" } });
  });
  it("E3: a diferença decimal sai arredondada", () => {
    const p = make([{ classification: "E3", skus: ["S1"], evidence: [{ source: "wms", reference: "r", description: "Contado 1.2 UN de 1.5 UN: Arroz 5kg" }] }]);
    expect(partialPrefill(p)).toEqual({ S1: { amount: "0.3", disposition: "devolver" } });
  });
  it("E1, E2, x", () => {
    for (const c of ["E1", "E2", "E4"])
      expect(partialPrefill(make([{ classification: c, skus: ["S1", "S2"], evidence: [] }]))).toEqual({
        S1: { amount: "10", disposition: "segurar" },
        S2: { amount: "5", disposition: "segurar" },
      });
  });
  it("item fora das divergências fica vazio e sem divergência de item não há o que preencher", () => {
    expect(partialPrefill(make([{ classification: "E4", skus: ["S1"], evidence: [] }]))).not.toHaveProperty("S2");
    expect(partialPrefill(make([]))).toEqual({});
  });
});
