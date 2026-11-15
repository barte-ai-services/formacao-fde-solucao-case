// #65 (história #34): a evidência da E5, nota sem ordem de compra.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DivergenceDto } from "../src/api/contract";
import { EvidenceView } from "../src/evidence";

const CHAVE = "35261112345678000190550010000123451000123456";

const SEFAZ: DivergenceDto["evidence"][number] = {
  source: "sefaz",
  reference: CHAVE,
  description: "Nota cita a ordem OC-9001",
};

const COMPRAS: DivergenceDto["evidence"][number] = {
  source: "erp_compras",
  reference: "OC-9001",
  description: "Compras não tem a ordem OC-9001",
};

function e5(evidence: DivergenceDto["evidence"], skus: string[] = []): DivergenceDto {
  return { classification: "E5", skus, evidence };
}

describe("#65 evidência da nota sem ordem", () => {
  it("#65/AC-4 com as duas evidências mostra a chave da SEFAZ, a ordem que Compras não tem e o encaminhamento", () => {
    render(<EvidenceView divergence={e5([SEFAZ, COMPRAS], ["SKU-12", "SKU-13"])} />);
    expect(screen.getByText("Nota sem ordem de compra")).toBeTruthy();
    expect(screen.getByText("Nota da SEFAZ")).toBeTruthy();
    expect(screen.getByText(CHAVE)).toBeTruthy();
    expect(screen.getByText("Nota cita a ordem OC-9001")).toBeTruthy();
    expect(screen.getByText("ERP · ordem de compra")).toBeTruthy();
    expect(screen.getByText("OC-9001")).toBeTruthy();
    expect(screen.getByText("Compras não tem a ordem OC-9001")).toBeTruthy();
    expect(screen.getByText("Encaminhada à coordenação")).toBeTruthy();
    expect(screen.getByText(/SKU-12, SKU-13/)).toBeTruthy();
  });

  it("#65 só com a evidência da SEFAZ mostra o que veio, sem inventar a de Compras", () => {
    render(<EvidenceView divergence={e5([SEFAZ])} />);
    expect(screen.getByText("Nota sem ordem de compra")).toBeTruthy();
    expect(screen.getByText(CHAVE)).toBeTruthy();
    expect(screen.queryByText("ERP · ordem de compra")).toBeNull();
    expect(screen.getByText("Encaminhada à coordenação")).toBeTruthy();
  });

  it("#65 nota que não cita ordem mostra 'sem referência' do lado de Compras", () => {
    render(
      <EvidenceView
        divergence={e5([
          { source: "sefaz", reference: CHAVE, description: "Nota sem ordem de compra citada" },
          { source: "erp_compras", reference: "sem referência", description: "Compras não tem ordem para esta nota" },
        ])}
      />,
    );
    expect(screen.getByText("sem referência")).toBeTruthy();
    expect(screen.getByText("Compras não tem ordem para esta nota")).toBeTruthy();
    expect(screen.getByText("Encaminhada à coordenação")).toBeTruthy();
  });

  it("#65 sem evidência da SEFAZ nem de Compras cai no genérico", () => {
    render(<EvidenceView divergence={e5([])} />);
    expect(screen.queryByText("Nota sem ordem de compra")).toBeNull();
    expect(screen.getByText("E5 · Nota sem ordem")).toBeTruthy();
    expect(screen.getByText("Nenhuma evidência veio com esta divergência.")).toBeTruthy();
  });
});
