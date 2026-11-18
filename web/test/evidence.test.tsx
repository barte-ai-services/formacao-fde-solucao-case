import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DivergenceDto } from "../src/api/contract";
import { EvidenceView } from "../src/evidence/EvidenceView";
import { clearEvidenceRegistry, registerEvidence, registeredEvidenceCodes } from "../src/evidence/registry";

const E3: DivergenceDto = {
  classification: "E3",
  exceptionCode: "E3",
  exceptionName: "Quantidade menor",
  skus: ["SKU-77"],
  evidence: [
    { source: "erp_compras", reference: "OC-4512", description: "Ordem de compra com 10 caixas" },
    { source: "wms", reference: "REC-88", description: "Recebimento contou 8 caixas" },
  ],
};

afterEach(() => clearEvidenceRegistry());

describe("#60/AC-2 evidência sem componente registrado aparece no genérico", () => {
  it("#60/AC-2 código sem registro mostra fonte, referência e descrição", () => {
    clearEvidenceRegistry();
    render(<EvidenceView divergence={E3} />);
    expect(screen.getByText("Quantidade menor")).toBeTruthy();
    expect(screen.getByText("ERP · ordem de compra")).toBeTruthy();
    expect(screen.getByText("OC-4512")).toBeTruthy();
    expect(screen.getByText(/Recebimento contou 8 caixas/)).toBeTruthy();
  });

  it("#60/AC-2 componente registrado que quebra cai no genérico, sem quebrar a tela", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    registerEvidence("E3", () => {
      throw new Error("quebrou");
    });
    render(<EvidenceView divergence={E3} />);
    expect(screen.getByText("Quantidade menor")).toBeTruthy();
    expect(screen.getByText("OC-4512")).toBeTruthy();
    quiet.mockRestore();
  });

  it("#60/AC-2 código e fonte que o contrato não conhece, e evidência vazia, não quebram", () => {
    const strange = { classification: "E9", exceptionCode: "E9", exceptionName: "Exceção desconhecida", skus: [], evidence: [{ source: "satelite", reference: "X", description: "?" }] };
    render(<EvidenceView divergence={strange as unknown as DivergenceDto} />);
    expect(screen.getByText("Exceção desconhecida")).toBeTruthy();
    expect(screen.getByText("satelite")).toBeTruthy();
    render(<EvidenceView divergence={{ classification: "E1", exceptionCode: "E1", exceptionName: "Falta física", skus: [], evidence: [] }} />);
    expect(screen.getByText("Nenhuma evidência veio com esta divergência.")).toBeTruthy();
  });

  it("componente registrado é o que aparece", () => {
    registerEvidence("E1", () => <p>evidência própria da E1</p>);
    render(<EvidenceView divergence={{ ...E3, classification: "E1" }} />);
    expect(screen.getByText("evidência própria da E1")).toBeTruthy();
  });

  it("o índice registra um arquivo por código, os nove", async () => {
    await import("../src/evidence");
    expect(registeredEvidenceCodes().sort()).toEqual(
      ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "NAO_CATALOGADA"].sort(),
    );
  });
});
