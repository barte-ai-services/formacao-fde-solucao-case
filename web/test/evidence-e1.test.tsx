import { render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import type { DivergenceDto } from "../src/api/contract";
import { EvidenceView } from "../src/evidence/EvidenceView";

// #44/AC-2 e AC-4: a evidência do E1 compara contagem, nota e pedido por item, com o que falta e o
// valor em risco. A divergência vem como o checkFaltaFisica do #69 a monta (NF-025, RC-9182, no kit).
const E1: DivergenceDto = {
  classification: "E1",
  exceptionCode: "E1",
  exceptionName: "Falta física",
  skus: ["SKU-1032", "SKU-1034"],
  evidence: [
    {
      source: "wms",
      reference: "RC-9182",
      description:
        "Não aparece na contagem: Batata chips 120 g (2408 UN, R$ 28.655,20); Biscoito recheado 140 g (5240 UN, R$ 19.859,60)",
    },
    {
      source: "erp_compras",
      reference: "OC-2026-42205",
      description: "A ordem pede os itens que não chegaram: F11-001, F11-003",
    },
  ],
};

beforeAll(async () => {
  await import("../src/evidence");
});

describe("#44 evidência da falta física (E1)", () => {
  it("AC-2: cada item que falta aparece com o contado na doca e o cobrado na nota", () => {
    render(<EvidenceView divergence={E1} />);
    const table = screen.getByRole("table", { name: "Contagem contra nota e pedido" });
    expect(within(table).getByText("Batata chips 120 g")).toBeTruthy();
    expect(within(table).getByText("2408 UN · R$ 28.655,20")).toBeTruthy();
    expect(within(table).getByText("Biscoito recheado 140 g")).toBeTruthy();
    expect(within(table).getAllByText("não contado")).toHaveLength(2);
  });

  it("AC-3: o pedido entra na comparação, pela ordem que pede os itens", () => {
    render(<EvidenceView divergence={E1} />);
    const table = screen.getByRole("table", { name: "Contagem contra nota e pedido" });
    expect(within(table).getAllByText("OC-2026-42205").length).toBeGreaterThan(0);
  });

  it("AC-4: o valor em risco é a soma do valor dos itens que faltam", () => {
    render(<EvidenceView divergence={E1} />);
    expect(screen.getByText("R$ 48.514,80")).toBeTruthy();
  });

  it("a fonte da contagem aparece com o recebimento", () => {
    render(<EvidenceView divergence={E1} />);
    expect(screen.getByText(/RC-9182/)).toBeTruthy();
    expect(screen.getByText("Falta física")).toBeTruthy();
  });

  it("evidência que não segue o formato do #69 cai no genérico, sem quebrar", () => {
    const odd: DivergenceDto = {
      classification: "E1",
      exceptionCode: "E1",
      exceptionName: "Falta física",
      skus: ["SKU-9"],
      evidence: [{ source: "wms", reference: "RC-1", description: "texto livre" }],
    };
    render(<EvidenceView divergence={odd} />);
    expect(screen.getByText(/texto livre/)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Contagem contra nota e pedido" })).toBeNull();
  });

  it("sem a evidência da ordem, a comparação mostra a ordem como ausente", () => {
    const first = E1.evidence[0];
    if (!first) throw new Error("fixture sem evidência");
    render(<EvidenceView divergence={{ ...E1, evidence: [first] }} />);
    const table = screen.getByRole("table", { name: "Contagem contra nota e pedido" });
    expect(within(table).getByText("sem ordem citada")).toBeTruthy();
  });
});
