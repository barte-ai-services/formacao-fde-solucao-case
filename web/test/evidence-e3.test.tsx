import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DivergenceDto } from "../src/api/contract";
import "../src/evidence/e3";
import { EvidenceView } from "../src/evidence/EvidenceView";

// #73: a divergência E3 como a API entrega, a partir do recebimento RC-9219 da base do kit.
const E3: DivergenceDto = {
  classification: "E3",
  skus: ["SKU-8001"],
  evidence: [
    { source: "wms", reference: "RC-9219", description: "Contado 75 UN de 100 UN: Óleo de soja 900 ml" },
    { source: "erp_compras", reference: "OC-2026-41901", description: "Ordem cobrada pela nota 37423" },
  ],
};

describe("#73 evidência do E3, quantidade menor", () => {
  it("#73/AC-1, regra 6: mostra o contado contra o cobrado, item a item, com a diferença a devolver", () => {
    render(<EvidenceView divergence={E3} />);
    expect(screen.getByText("E3 · Quantidade menor")).toBeTruthy();
    expect(screen.getAllByText("Óleo de soja 900 ml").length).toBeGreaterThan(0);
    expect(screen.getByText("75 UN recebidas")).toBeTruthy();
    expect(screen.getByText("100 UN cobradas")).toBeTruthy();
    expect(screen.getByText("25 UN")).toBeTruthy();
  });

  it("#73/AC-1, regra 6: cita as fontes, o recebimento do WMS e a ordem de compra", () => {
    render(<EvidenceView divergence={E3} />);
    expect(screen.getByText("RC-9219")).toBeTruthy();
    expect(screen.getByText("OC-2026-41901")).toBeTruthy();
    expect(screen.getByText("ERP · ordem de compra")).toBeTruthy();
  });

  it("#73/AC-1: com duas linhas a menos, mostra as duas", () => {
    const two: DivergenceDto = {
      ...E3,
      skus: ["SKU-1", "SKU-2"],
      evidence: [
        { source: "wms", reference: "RC-1", description: "Contado 75 UN de 100 UN: Arroz 5 kg" },
        { source: "wms", reference: "RC-1", description: "Contado 10 UN de 12 UN: Feijão 1 kg" },
      ],
    };
    render(<EvidenceView divergence={two} />);
    expect(screen.getByText("75 UN recebidas")).toBeTruthy();
    expect(screen.getByText("10 UN recebidas")).toBeTruthy();
    expect(screen.getByText("2 UN")).toBeTruthy();
  });

  it("#73: evidência que não traz a contagem no formato esperado cai no genérico, sem quebrar", () => {
    const odd: DivergenceDto = {
      classification: "E3",
      skus: [],
      evidence: [{ source: "wms", reference: "RC-2", description: "Recebimento contou 8 caixas" }],
    };
    render(<EvidenceView divergence={odd} />);
    expect(screen.getByText("E3 · Quantidade menor")).toBeTruthy();
    expect(screen.getByText(/Recebimento contou 8 caixas/)).toBeTruthy();
  });
});
