import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DivergenceDto } from "../src/api/contract";
import "../src/evidence/e3";
import { EvidenceView } from "../src/evidence/EvidenceView";

// #73: a divergência E3 como a API entrega, a partir do recebimento RC-9219 da base do kit.
const E3: DivergenceDto = {
  classification: "E3",
  exceptionCode: "E3",
  exceptionName: "Quantidade menor",
  skus: ["SKU-8001"],
  evidence: [
    { source: "wms", reference: "RC-9219", description: "Contado 75 UN de 100 UN: Óleo de soja 900 ml" },
    { source: "erp_compras", reference: "OC-2026-41901", description: "Ordem cobrada pela nota 37423" },
  ],
};

describe("#73 evidência do E3, quantidade menor", () => {
  it("#73/AC-1, regra 6: mostra o contado contra o cobrado, item a item, com a diferença a devolver", () => {
    render(<EvidenceView divergence={E3} />);
    expect(screen.getByText("Quantidade menor")).toBeTruthy();
    expect(screen.getByText("Evidência: recebimento RC-9219")).toBeTruthy();
    expect(screen.getAllByText("Óleo de soja 900 ml").length).toBeGreaterThan(0);
    expect(screen.getAllByText("75 UN recebidas").length).toBeGreaterThan(0);
    expect(screen.getAllByText("100 UN cobradas").length).toBeGreaterThan(0);
    expect(screen.getByText(/devolver 25 UN/)).toBeTruthy();
  });

  it("#73/AC-1, regra 6: cita a ordem de compra como linha que bate", () => {
    render(<EvidenceView divergence={E3} />);
    expect(screen.getByText("Ordem de compra")).toBeTruthy();
    expect(screen.getAllByText("OC-2026-41901").length).toBeGreaterThan(0);
  });

  it("#73/AC-1: com duas linhas a menos, mostra as duas e cita o recebimento uma vez só", () => {
    const two: DivergenceDto = {
      ...E3,
      skus: ["SKU-1", "SKU-2"],
      evidence: [
        { source: "wms", reference: "RC-1", description: "Contado 75 UN de 100 UN: Arroz 5 kg" },
        { source: "wms", reference: "RC-1", description: "Contado 10 UN de 12 UN: Feijão 1 kg" },
      ],
    };
    const { container } = render(<EvidenceView divergence={two} />);
    expect(screen.getAllByText("75 UN recebidas").length).toBeGreaterThan(0);
    expect(screen.getAllByText("10 UN recebidas").length).toBeGreaterThan(0);
    expect(screen.getByText(/devolver 2 UN/)).toBeTruthy();
    expect(container.textContent?.match(/RC-1/g)).toHaveLength(1);
  });

  it("#73: uma linha do WMS fora do formato faz tudo cair no genérico, sem esconder item", () => {
    const mixed: DivergenceDto = {
      classification: "E3",
      exceptionCode: "E3",
      exceptionName: "Quantidade menor",
      skus: ["SKU-1", "SKU-2"],
      evidence: [
        { source: "wms", reference: "RC-2", description: "Contado 75 UN de 100 UN: Arroz 5 kg" },
        { source: "wms", reference: "RC-2", description: "Recebimento contou 8 caixas" },
      ],
    };
    render(<EvidenceView divergence={mixed} />);
    expect(screen.getByText(/Recebimento contou 8 caixas/)).toBeTruthy();
    expect(screen.getByText(/Contado 75 UN de 100 UN/)).toBeTruthy();
  });

  it("#73: quantidade com casas decimais não é o formato do E3 e cai no genérico", () => {
    const decimal: DivergenceDto = {
      classification: "E3",
      exceptionCode: "E3",
      exceptionName: "Quantidade menor",
      skus: ["SKU-1"],
      evidence: [{ source: "wms", reference: "RC-3", description: "Contado 10.1 UN de 10.3 UN: Arroz 5 kg" }],
    };
    render(<EvidenceView divergence={decimal} />);
    expect(screen.getByText(/Contado 10.1 UN de 10.3 UN/)).toBeTruthy();
  });
});
