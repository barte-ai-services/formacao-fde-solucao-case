import { describe, expect, it } from "vitest";
import { shortDate } from "./supplier-request-view";

// #19 A data curta da coluna Prazo e do bloco "Pedido ao fornecedor" (história #5).

describe("#19 shortDate", () => {
  it("#5/AC-1: a data ISO vira dia e mês, como a coluna Prazo do wireframe", () => {
    expect(shortDate("2026-11-14")).toBe("14/11");
  });

  it("#5/AC-1: o que não é data ISO volta como veio, sem inventar dia nem mês", () => {
    expect(shortDate("")).toBe("");
    expect(shortDate("amanhã")).toBe("amanhã");
  });
});
