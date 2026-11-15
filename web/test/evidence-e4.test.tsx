import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DivergenceDto, EvidenceDto } from "../src/api/contract";
import { EvidenceView } from "../src/evidence/EvidenceView";
import { UnidadeDeMedidaEvidence } from "../src/evidence/e4";
import { clearEvidenceRegistry, registerEvidence } from "../src/evidence/registry";

/** #37: as três evidências por SKU, no texto exato que `api/src/domain/checks/e4-unidade-de-medida.ts` gera. */
function e4Evidence(opts: {
  sku: string;
  order: string;
  nota: [number, "UN" | "CX", string];
  ordem: [number, "UN" | "CX", string];
  fator: number;
  notaUn: number;
  ordemUn: number;
}): EvidenceDto[] {
  const { sku, order, nota, ordem, fator, notaUn, ordemUn } = opts;
  return [
    {
      source: "sefaz",
      reference: "35261100000000000000550010000000081000000008",
      description: `Item ${sku} na nota: ${nota[0]} ${nota[1]} a ${nota[2]}`,
    },
    {
      source: "erp_compras",
      reference: order,
      description: `Item ${sku} na ordem: ${ordem[0]} ${ordem[1]} a ${ordem[2]}`,
    },
    {
      source: "erp_cadastro",
      reference: sku,
      description: `Produto ${sku}: fator de caixa ${fator}; nota ${notaUn} UN, ordem ${ordemUn} UN`,
    },
  ];
}

const NF_008: DivergenceDto = {
  classification: "E4",
  skus: ["SKU-1025"],
  evidence: e4Evidence({
    sku: "SKU-1025",
    order: "OC-2026-42673",
    nota: [232, "CX", "R$ 18,76"],
    ordem: [928, "UN", "R$ 4,69"],
    fator: 4,
    notaUn: 928,
    ordemUn: 928,
  }),
};

const NAO_BATE: DivergenceDto = {
  classification: "E4",
  skus: ["SKU-77"],
  evidence: e4Evidence({
    sku: "SKU-77",
    order: "OC-4512",
    nota: [10, "CX", "R$ 20,00"],
    ordem: [48, "UN", "R$ 5,00"],
    fator: 4,
    notaUn: 40,
    ordemUn: 48,
  }),
};

afterEach(() => clearEvidenceRegistry());

/** #37: registra a E4 de novo a cada teste, porque o registro se esvazia entre eles. */
function renderE4(divergence: DivergenceDto) {
  registerEvidence("E4", UnidadeDeMedidaEvidence);
  return render(<EvidenceView divergence={divergence} />);
}

/** #37: a linha do comparativo cujo rótulo é `label`, dentro da tabela do SKU. */
function rowOf(sku: string, label: string): HTMLElement {
  const table = screen.getByRole("table", { name: `Conversão do ${sku}` });
  const header = within(table).getByRole("rowheader", { name: label });
  const row = header.closest<HTMLElement>('[role="row"]');
  if (row === null) throw new Error(`linha ${label} sem role=row`);
  return row;
}

describe("#37 evidência da E4: a conversão e o fator a corrigir", () => {
  it("#37/AC-1 a NF-008 mostra 232 CX, 928 UN e a conversão 232 CX × fator 4 = 928 UN batendo", () => {
    renderE4(NF_008);

    const quantidade = rowOf("SKU-1025", "Quantidade");
    expect(within(quantidade).getByText("232 CX")).toBeTruthy();
    expect(within(quantidade).getByText("928 UN")).toBeTruthy();

    const convertido = rowOf("SKU-1025", "Convertido");
    expect(within(convertido).getByText("232 CX × fator 4 = 928 UN")).toBeTruthy();
    expect(within(convertido).getByText("confere")).toBeTruthy();
    expect(screen.getByText(/OC-2026-42673/)).toBeTruthy();
  });

  it("#37/AC-2 a conversão vem antes de qualquer comparação, e nada fala em diferença de preço", () => {
    const { container } = renderE4(NF_008);

    const table = screen.getByRole("table", { name: "Conversão do SKU-1025" });
    const rows = within(table)
      .getAllByRole("row")
      .filter((row) => within(row).queryByRole("rowheader") !== null);
    const judged = rows.filter((row) => /confere|divergente/.test(row.textContent ?? ""));
    const primeira = judged[0];
    if (primeira === undefined) throw new Error("nenhuma linha julgada");
    expect(within(primeira).getByRole("rowheader").textContent).toBe("Convertido");

    const preco = rowOf("SKU-1025", "Preço");
    expect(within(preco).getByText("R$ 18,76 por CX")).toBeTruthy();
    expect(within(preco).getByText("R$ 4,69 por UN")).toBeTruthy();
    expect(within(preco).getByText("não comparável")).toBeTruthy();
    expect(container.textContent ?? "").not.toMatch(/diferen[cç]a de pre[cç]o/i);
  });

  it("#37/AC-5 mostra o fator a corrigir no Cadastro, o do cadastro e o observado", () => {
    const { container } = renderE4(NF_008);

    const fator = container.querySelector<HTMLElement>('[aria-label="Fator a corrigir no Cadastro"]');
    if (fator === null) throw new Error("sem a lista do fator a corrigir");
    expect(within(fator).getByText("SKU-1025")).toBeTruthy();
    expect(within(fator).getByText("Cadastro: 1 CX = 4 UN · observado: 1 CX = 4 UN")).toBeTruthy();
  });

  it("#37/AC-2 convertido que não bate com a ordem aparece divergente", () => {
    renderE4(NAO_BATE);

    const convertido = rowOf("SKU-77", "Convertido");
    expect(within(convertido).getByText("10 CX × fator 4 = 40 UN")).toBeTruthy();
    expect(within(convertido).getByText("48 UN")).toBeTruthy();
    expect(within(convertido).getByText("divergente")).toBeTruthy();
    expect(
      screen.getByText("Cadastro: 1 CX = 4 UN · observado: 10 CX para 48 UN, não fecha em caixa inteira"),
    ).toBeTruthy();
  });

  it("#37/AC-2 a ordem em CX e a nota em UN também convertem, do lado da ordem", () => {
    const invertida: DivergenceDto = {
      classification: "E4",
      skus: ["SKU-9"],
      evidence: e4Evidence({
        sku: "SKU-9",
        order: "OC-9",
        nota: [48, "UN", "R$ 5,00"],
        ordem: [12, "CX", "R$ 20,00"],
        fator: 4,
        notaUn: 48,
        ordemUn: 48,
      }),
    };
    renderE4(invertida);
    const convertido = rowOf("SKU-9", "Convertido");
    expect(within(convertido).getByText("48 UN")).toBeTruthy();
    expect(within(convertido).getByText("12 CX × fator 4 = 48 UN")).toBeTruthy();
    expect(within(convertido).getByText("confere")).toBeTruthy();
  });

  it("#37/AC-2 descrições que não parseiam, ou lista vazia, caem no genérico sem quebrar", () => {
    const estranha: DivergenceDto = {
      classification: "E4",
      skus: ["SKU-1"],
      evidence: [{ source: "sefaz", reference: "CHAVE-1", description: "Caixa contra unidade, sem número" }],
    };
    renderE4(estranha);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("CHAVE-1")).toBeTruthy();
    expect(screen.getByText(/Caixa contra unidade, sem número/)).toBeTruthy();

    renderE4({ classification: "E4", skus: [], evidence: [] });
    expect(screen.getByText("Nenhuma evidência veio com esta divergência.")).toBeTruthy();

    const semCadastro: DivergenceDto = { ...NF_008, evidence: NF_008.evidence.slice(0, 2) };
    renderE4(semCadastro);
    expect(screen.queryByRole("table")).toBeNull();
  });
});
