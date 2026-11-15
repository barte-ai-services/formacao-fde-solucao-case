import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DivergenceDto, DuplicateDto, DuplicatesResponseDto, TitleState } from "../src/api/contract";
import NotasDuplicadas from "../src/routes/duplicadas";
import { EvidenceView } from "../src/evidence/EvidenceView";
// O arquivo registra a E6 ao carregar, como o índice faz na tela.
import "../src/evidence/e6";

const NF012: DuplicatesResponseDto = {
  duplicates: [
    {
      duplicate: {
        accessKey: "35261100000000000000550010000894281000000012",
        number: "89428",
        supplierId: "FORN-07",
        issuedOn: "2026-11-10",
        totalCents: 120960,
        total: "R$ 1.209,60",
      },
      original: { accessKey: "35261100000000000000550010000894101000000010", number: "89410", status: "lançada" },
      reason: "titulo_lancado",
      titleState: "bloqueado",
      blockedAmountCents: 120960,
      blockedAmount: "R$ 1.209,60",
    },
  ],
  count: 1,
};

const NO_BALANCE: DuplicatesResponseDto = {
  duplicates: [
    {
      duplicate: {
        accessKey: "35261100000000000000550010000895001000000099",
        number: "89500",
        supplierId: "FORN-09",
        issuedOn: "2026-11-11",
        totalCents: 45000,
        total: "R$ 450,00",
      },
      original: null,
      reason: "ordem_sem_saldo",
      titleState: "bloqueado",
      blockedAmountCents: 45000,
      blockedAmount: "R$ 450,00",
    },
  ],
  count: 1,
};

function serve(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#31/AC-6 o controller vê a nota duplicada, a original e o valor barrado", () => {
  it("#31/AC-6 a rota mostra a duplicada, a original e o valor barrado do caso NF-012", async () => {
    const fetchMock = serve(NF012);
    render(<NotasDuplicadas params={{}} />);
    expect(await screen.findByRole("button", { name: "Abrir a nota 89428" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/duplicates", expect.objectContaining({ method: "GET" }));
    expect(screen.getByText("NF 89410")).toBeTruthy();
    expect(screen.getByText("lançada")).toBeTruthy();
    expect(screen.getByText("mesma ordem e mesmo valor de um título já lançado")).toBeTruthy();
    // O valor barrado da linha, em negrito, e o total barrado no destaque.
    expect(screen.getAllByText("R$ 1.209,60").length).toBeGreaterThan(0);
    expect(screen.getByText(/R\$\s1\.209,60/, { selector: "b" })).toBeTruthy();
    expect(screen.getByText("Título bloqueado")).toBeTruthy();
    expect(screen.getByText("Duplicadas")).toBeTruthy();
  });

  it("#31/AC-6 o botão da nota abre o detalhe pelo teclado, sem clicar na linha", async () => {
    serve(NF012);
    render(<NotasDuplicadas params={{}} />);
    const open = await screen.findByRole("button", { name: "Abrir a nota 89428" });
    expect(open.getAttribute("type")).toBe("button");
    expect(screen.queryByText("NF 89428, duplicada")).toBeNull();
    fireEvent.click(open);
    expect(await screen.findByText("NF 89428, duplicada")).toBeTruthy();
    // Um drawer só: o clique no botão não chega à linha.
    expect(screen.getAllByText("NF 89428, duplicada")).toHaveLength(1);
    expect(screen.getAllByText("Original · NF 89410").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Duplicada · NF 89428").length).toBeGreaterThan(0);
  });

  it("#31/AC-6 original nula mostra o texto de ordem sem saldo", async () => {
    serve(NO_BALANCE);
    render(<NotasDuplicadas params={{}} />);
    expect(await screen.findByText("sem título original: a ordem não tem saldo")).toBeTruthy();
    expect(screen.getByText("duplicidade suspeita: a ordem não tem saldo")).toBeTruthy();
    expect(screen.getByText("R$ 450,00", { selector: "b" })).toBeTruthy();
  });

  it("#31/AC-6 lista vazia mostra o texto de vazio", async () => {
    serve({ duplicates: [], count: 0 });
    render(<NotasDuplicadas params={{}} />);
    expect(await screen.findByText(/Nenhuma nota duplicada neste mês/)).toBeTruthy();
  });

  for (const status of [401, 500]) {
    it(`#31/AC-6 erro ${status} mostra o estado de erro`, async () => {
      serve({ error: status === 401 ? "unauthenticated" : "internal" }, status);
      render(<NotasDuplicadas params={{}} />);
      expect(await screen.findByText("Não consegui ler as duplicidades agora")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    });
  }
});

describe("#31/AC-6 a evidência E6 desenha os dois motivos", () => {
  const POSTED: DivergenceDto = {
    classification: "E6",
    skus: ["SKU-12"],
    evidence: [
      {
        source: "erp_contas_a_pagar",
        reference: "KEY-89410",
        description: "Título já lançado da nota 89410, ordem OC-7781, R$ 1.209,60, situação lançada",
      },
      { source: "sefaz", reference: "KEY-89428", description: "Nota 89428 cobra a mesma ordem e o mesmo valor" },
    ],
  };
  const NO_BALANCE_DIVERGENCE: DivergenceDto = {
    classification: "E6",
    skus: ["SKU-30"],
    evidence: [
      {
        source: "erp_compras",
        reference: "OC-9001",
        description: "Duplicidade suspeita: a ordem OC-9001 não tem saldo para Arroz 5 kg (A-5)",
      },
    ],
  };

  it("#31/AC-6 título já lançado: o título original contra a nota nova", () => {
    render(<EvidenceView divergence={POSTED} />);
    expect(screen.getByText("E6 · Duplicidade")).toBeTruthy();
    expect(screen.getByText("Evidência: nota 89410 já lançada")).toBeTruthy();
    expect(screen.getAllByText(/NF 89410/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/NF 89428/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("OC-7781").length).toBeGreaterThan(0);
    expect(screen.getByText("KEY-89410")).toBeTruthy();
    expect(screen.getByText("KEY-89428")).toBeTruthy();
  });

  it("#31/AC-6 ordem sem saldo: a duplicidade suspeita, sem título original", () => {
    render(<EvidenceView divergence={NO_BALANCE_DIVERGENCE} />);
    expect(screen.getByText("Evidência: duplicidade suspeita, a ordem de compra não tem saldo")).toBeTruthy();
    expect(screen.getByText("ERP · ordem de compra")).toBeTruthy();
    expect(screen.getByText("OC-9001")).toBeTruthy();
    expect(screen.getByText(/não tem saldo para Arroz 5 kg/)).toBeTruthy();
  });
});

describe("#31/AC-6 o selo do título segue o estado real do contas a pagar", () => {
  function withState(titleState: TitleState | null): DuplicatesResponseDto {
    const item: DuplicateDto = { ...NF012.duplicates[0]!, titleState };
    return { duplicates: [item], count: 1 };
  }

  async function openDrawer() {
    fireEvent.click(await screen.findByRole("button", { name: "Abrir a nota 89428" }));
    return within(document.body);
  }

  it("#31/AC-6 bloqueado mostra Título bloqueado, na linha e no detalhe", async () => {
    serve(withState("bloqueado"));
    render(<NotasDuplicadas params={{}} />);
    expect(await screen.findByText("Título bloqueado")).toBeTruthy();
    const page = await openDrawer();
    expect(page.getAllByText("Título bloqueado").length).toBeGreaterThan(1);
    expect(page.queryByText("Bloqueio pendente")).toBeNull();
  });

  for (const state of ["lancado", null] as const) {
    it(`#31/AC-6 ${String(state)} mostra Bloqueio pendente, nunca Título bloqueado`, async () => {
      serve(withState(state));
      render(<NotasDuplicadas params={{}} />);
      expect(await screen.findByText("Bloqueio pendente")).toBeTruthy();
      expect(screen.queryByText("Título bloqueado")).toBeNull();
      const page = await openDrawer();
      expect(page.getAllByText("Bloqueio pendente").length).toBeGreaterThan(1);
      expect(page.queryByText("Título bloqueado")).toBeNull();
    });
  }

  it("#31/AC-6 outro estado mostra o rótulo do estado", async () => {
    serve(withState("liberado"));
    render(<NotasDuplicadas params={{}} />);
    expect(await screen.findByText("Título liberado")).toBeTruthy();
    expect(screen.queryByText("Título bloqueado")).toBeNull();
    const page = await openDrawer();
    expect(page.getAllByText("Título liberado").length).toBeGreaterThan(1);
  });
});
