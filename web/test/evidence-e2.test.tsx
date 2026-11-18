import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DivergenceDto } from "../src/api/contract";
// #97: o índice registra a E2; cada arquivo de teste roda isolado do evidence.test.tsx, que esvazia o registro.
import { EvidenceView, GenericEvidence, evidenceComponentFor } from "../src/evidence";

// A divergência como o domínio emite para a NF-001 da base do kit (#36, #97): F02-001 veio no lugar de F02-003.
const NF001_E2: DivergenceDto = {
  classification: "E2",
  exceptionCode: "E2",
  exceptionName: "Item trocado",
  skus: ["SKU-1005"],
  evidence: [
    {
      source: "erp_compras",
      reference: "OC-2026-42328",
      description: "Ordem OC-2026-42328 pede Suco de uva integral 1 L (F02-003), não Água mineral 1,5 L",
    },
    {
      source: "erp_cadastro",
      reference: "SKU-1005",
      description: "F02-001 é Água mineral 1,5 L no cadastro do fornecedor F02, fora da ordem",
    },
    {
      source: "sefaz",
      reference: "35261174055489000148550010000438941174512643",
      description: "Nota cobra Água mineral 1,5 L (F02-001) por R$ 535,68",
    },
  ],
};

describe("#97 evidência da E2 · item trocado (#94, #36)", () => {
  it("#97/AC-1 (#94/AC-1) mostra a ordem, o item pedido e o item que veio, com a evidência de cada sistema", () => {
    render(<EvidenceView divergence={NF001_E2} />);
    expect(screen.getByText("Item trocado")).toBeTruthy();
    expect(screen.getAllByText("OC-2026-42328").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Suco de uva integral 1 L (F02-003)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Água mineral 1,5 L (F02-001)").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SKU-1005/).length).toBeGreaterThan(0);
    expect(screen.getByText("ERP · ordem de compra")).toBeTruthy();
    expect(screen.getByText("ERP · cadastro")).toBeTruthy();
    expect(screen.getByText("Nota da SEFAZ")).toBeTruthy();
    expect(screen.getByText("35261174055489000148550010000438941174512643")).toBeTruthy();
  });

  it("#97/AC-2 (#94/AC-2, #36/AC-2) o valor do item trocado é o da regra, R$ 535,68", () => {
    render(<EvidenceView divergence={NF001_E2} />);
    expect(screen.getByText("Valor do item trocado")).toBeTruthy();
    expect(screen.getAllByText("R$ 535,68").length).toBeGreaterThan(0);
  });

  it("#97 sem a evidência da SEFAZ, o item que veio sai do cadastro e o valor aparece como indisponível", () => {
    const withoutSefaz = { ...NF001_E2, evidence: NF001_E2.evidence.slice(0, 2) };
    render(<EvidenceView divergence={withoutSefaz} />);
    expect(screen.getAllByText("Suco de uva integral 1 L (F02-003)").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("F02-001 é Água mineral 1,5 L no cadastro do fornecedor F02, fora da ordem").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Valor indisponível")).toBeTruthy();
    expect(screen.queryByText("R$ 535,68")).toBeNull();
  });

  it("#97 item cuja descrição tem \" por \" ainda separa o item do valor", () => {
    const evidence = NF001_E2.evidence.map((item) =>
      item.source === "sefaz" ? { ...item, description: "Nota cobra Kit por quilo (F02-009) por R$ 12,00" } : item,
    );
    render(<EvidenceView divergence={{ ...NF001_E2, evidence }} />);
    expect(screen.getByText("Kit por quilo (F02-009)")).toBeTruthy();
    expect(screen.getByText("R$ 12,00")).toBeTruthy();
  });

  it("#97 descrição e referência que não são texto não quebram o painel da E2", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const odd = {
      ...NF001_E2,
      evidence: [
        ...NF001_E2.evidence,
        { source: "wms", reference: { x: 1 }, description: { x: 1 } },
        { source: "banco", reference: 42, description: 7 },
      ],
    };
    render(<EvidenceView divergence={odd as unknown as DivergenceDto} />);
    expect(screen.getByText("Item trocado")).toBeTruthy();
    expect(screen.getByText("Valor do item trocado")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    quiet.mockRestore();
  });

  it("#97 só a evidência com objetos no lugar do texto ainda mostra o painel da E2", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const odd = { classification: "E2", exceptionCode: "E2", exceptionName: "Item trocado", skus: [], evidence: [{ source: "sefaz", reference: { x: 1 }, description: { x: 1 } }] };
    render(<EvidenceView divergence={odd as unknown as DivergenceDto} />);
    expect(screen.getByText("Item trocado")).toBeTruthy();
    expect(screen.getByText("Nota da SEFAZ")).toBeTruthy();
    quiet.mockRestore();
  });

  it("#97 nota da SEFAZ sem valor no fim não vira valor do item trocado", () => {
    const withSefaz = (description: string) =>
      NF001_E2.evidence.map((item) => (item.source === "sefaz" ? { ...item, description } : item));
    const { unmount } = render(
      <EvidenceView divergence={{ ...NF001_E2, evidence: withSefaz("Nota emitida por Fornecedor X") }} />,
    );
    expect(screen.getByText("Valor indisponível")).toBeTruthy();
    expect(screen.getAllByText("Nota emitida por Fornecedor X")).toHaveLength(1);
    expect(screen.queryByText("Fornecedor X")).toBeNull();
    unmount();
    render(<EvidenceView divergence={{ ...NF001_E2, evidence: withSefaz("Nota cobra Kit por quilo (F02-009)") }} />);
    expect(screen.getByText("Valor indisponível")).toBeTruthy();
    expect(screen.queryByText("quilo (F02-009)")).toBeNull();
    expect(
      screen.getAllByText("F02-001 é Água mineral 1,5 L no cadastro do fornecedor F02, fora da ordem").length,
    ).toBeGreaterThan(1);
  });

  it("#97 sem a evidência do ERP Compras, a ordem de compra aparece como ausente", () => {
    const withoutOrder = { ...NF001_E2, evidence: NF001_E2.evidence.slice(1) };
    render(<EvidenceView divergence={withoutOrder} />);
    expect(screen.getByText("Item trocado")).toBeTruthy();
    expect(screen.getAllByText("ausente").length).toBeGreaterThan(0);
    expect(screen.queryByText("confere")).toBeNull();
  });

  it("#97 descrição fora do formato aparece como veio, sem quebrar", () => {
    const malformed: DivergenceDto = {
      classification: "E2",
      exceptionCode: "E2",
      exceptionName: "Item trocado",
      skus: ["SKU-1005"],
      evidence: [{ source: "erp_compras", reference: "OC-9", description: "texto que o domínio mudou" }],
    };
    render(<EvidenceView divergence={malformed} />);
    expect(screen.getByText("Item trocado")).toBeTruthy();
    expect(screen.getAllByText("OC-9").length).toBeGreaterThan(0);
    expect(screen.getAllByText("texto que o domínio mudou").length).toBeGreaterThan(0);
  });

  it("#97 evidência vazia cai no painel genérico e evidência ilegível não quebra a E2", () => {
    render(<EvidenceView divergence={{ classification: "E2", exceptionCode: "E2", exceptionName: "Item trocado", skus: [], evidence: [] }} />);
    expect(screen.getByText("Nenhuma evidência veio com esta divergência.")).toBeTruthy();
    const garbage = { classification: "E2", exceptionCode: "E2", exceptionName: "Item trocado", skus: null, evidence: [null, { source: 7 }] };
    render(<EvidenceView divergence={garbage as unknown as DivergenceDto} />);
    expect(screen.getAllByText("Item trocado").length).toBe(2);
  });

  it("#97 o índice registra o componente próprio da E2, e não o genérico", () => {
    const component = evidenceComponentFor("E2");
    expect(component).toBeDefined();
    expect(component).not.toBe(GenericEvidence);
  });
});
