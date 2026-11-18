import { render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import type { DivergenceDto } from "../src/api/contract";
import { EvidenceView } from "../src/evidence/EvidenceView";

// #66 (história #35): a evidência do E8 mostra o item que não está no cadastro do fornecedor, as três
// buscas que falharam e para onde a aprovação manda. A divergência vem como o checkItemSemCadastro a monta
// (NF-009, fornecedor F02, nota N27, item sem SKU).
const NF009: DivergenceDto = {
  classification: "E8",
  exceptionCode: "E8",
  exceptionName: "Item sem cadastro",
  skus: [],
  evidence: [
    {
      source: "erp_cadastro",
      reference: "F02/F02-N27",
      description:
        'O item "Isotônico limão 500 ml (lançamento)" (código do fornecedor F02-N27, SKU vazio, valor R$ 354,00) ' +
        "não está no cadastro do fornecedor F02: não casa por SKU, por código do fornecedor nem por descrição.",
    },
  ],
};

const COM_SKU: DivergenceDto = {
  classification: "E8",
  exceptionCode: "E8",
  exceptionName: "Item sem cadastro",
  skus: ["SKU-77"],
  evidence: [
    {
      source: "erp_cadastro",
      reference: "F02/F02-N30",
      description:
        'O item "Água de coco 1 l" (código do fornecedor F02-N30, SKU SKU-77, valor R$ 1.200,50) ' +
        "não está no cadastro do fornecedor F02: não casa por SKU, por código do fornecedor nem por descrição.",
    },
  ],
};

beforeAll(async () => {
  await import("../src/evidence");
});

describe("#66 evidência do item sem cadastro (E8)", () => {
  it("o item aparece com a descrição, o código do fornecedor e SKU vazio", () => {
    render(<EvidenceView divergence={NF009} />);
    const table = screen.getByRole("table", { name: "Item sem cadastro" });
    expect(within(table).getByText("Isotônico limão 500 ml (lançamento)")).toBeTruthy();
    expect(within(table).getByText("F02-N27")).toBeTruthy();
    expect(within(table).getByText("SKU vazio")).toBeTruthy();
    expect(screen.getByText("Item sem cadastro")).toBeTruthy();
  });

  it("o valor do item é o valor em risco", () => {
    render(<EvidenceView divergence={NF009} />);
    expect(screen.getByText("R$ 354,00")).toBeTruthy();
  });

  it("a fonte é o Cadastro do ERP, com a referência", () => {
    render(<EvidenceView divergence={NF009} />);
    expect(screen.getAllByText(/Cadastro do ERP/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/F02\/F02-N27/).length).toBeGreaterThan(0);
  });

  it("as três buscas que falharam aparecem", () => {
    render(<EvidenceView divergence={NF009} />);
    const table = screen.getByRole("table", { name: "Item sem cadastro" });
    expect(within(table).getByText("Busca por SKU")).toBeTruthy();
    expect(within(table).getByText("Busca por código do fornecedor")).toBeTruthy();
    expect(within(table).getByText("Busca por descrição")).toBeTruthy();
    expect(within(table).getAllByText("não encontrado")).toHaveLength(3);
  });

  it("AC-4 e AC-5: diz que vai à coordenação e que aprovar manda o item ao Cadastro", () => {
    render(<EvidenceView divergence={NF009} />);
    expect(screen.getByText(/coordenação, ou acima quando a nota passa de R\$ 100 mil/)).toBeTruthy();
    expect(screen.getByText(/ao Cadastro/)).toBeTruthy();
    expect(screen.queryByText("Vai para a coordenação")).toBeNull();
  });

  it("com a evidência da ordem, mostra a linha Ordem com o id, travada e o motivo", () => {
    const comOrdem: DivergenceDto = {
      ...NF009,
      evidence: [
        ...NF009.evidence,
        {
          source: "erp_compras",
          reference: "OC-2026-42301",
          description: "Ordem OC-2026-42301 travada: item sem cadastro de produto",
        },
      ],
    };
    render(<EvidenceView divergence={comOrdem} />);
    const table = screen.getByRole("table", { name: "Item sem cadastro" });
    expect(within(table).getByText("Ordem")).toBeTruthy();
    expect(within(table).getByText("OC-2026-42301")).toBeTruthy();
    expect(within(table).getByText("travada")).toBeTruthy();
    expect(within(table).getByText(/item sem cadastro de produto/)).toBeTruthy();
  });

  it("sem a evidência da ordem, não mostra a linha Ordem", () => {
    render(<EvidenceView divergence={NF009} />);
    const table = screen.getByRole("table", { name: "Item sem cadastro" });
    expect(within(table).queryByText("Ordem")).toBeNull();
    expect(within(table).queryByText("travada")).toBeNull();
  });

  it("com SKU, mostra o SKU e o valor com milhar", () => {
    render(<EvidenceView divergence={COM_SKU} />);
    expect(screen.getByText("SKU-77")).toBeTruthy();
    expect(screen.getByText("R$ 1.200,50")).toBeTruthy();
  });

  it("várias divergências E8 renderizam um bloco cada", () => {
    render(
      <>
        <EvidenceView divergence={NF009} />
        <EvidenceView divergence={COM_SKU} />
      </>,
    );
    expect(screen.getAllByRole("table", { name: "Item sem cadastro" })).toHaveLength(2);
    expect(screen.getAllByText("Item sem cadastro")).toHaveLength(2);
  });

  it("sem evidência, não quebra e diz que nada veio", () => {
    render(<EvidenceView divergence={{ classification: "E8", exceptionCode: "E8", exceptionName: "Item sem cadastro", skus: [], evidence: [] }} />);
    expect(screen.getByText("Nenhuma evidência veio com esta divergência.")).toBeTruthy();
  });

  it("frase fora do formato mostra a frase da evidência, sem inventar campos", () => {
    const odd: DivergenceDto = {
      classification: "E8",
      exceptionCode: "E8",
      exceptionName: "Item sem cadastro",
      skus: [],
      evidence: [{ source: "erp_cadastro", reference: "F02/X", description: "texto livre" }],
    };
    render(<EvidenceView divergence={odd} />);
    expect(screen.getAllByText(/texto livre/).length).toBeGreaterThan(0);
    expect(screen.queryByText("R$ 354,00")).toBeNull();
  });
});
