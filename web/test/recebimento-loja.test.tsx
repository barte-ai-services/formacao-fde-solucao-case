import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { fallbackContext, NAVIGATION } from "../src/shell/context";

// #135 A tela "Recebimento na loja" contra uma API falsa no formato de /api/recebimento-loja. Notas de loja do kit: LJ-012 em 2026-11-12.

const board = {
  destination: "LJ-012",
  date: "2026-11-12",
  destinations: ["LJ-012", "LJ-030"],
  awaiting: 1,
  rows: [
    {
      invoiceAccessKey: "35261162833783000154550010000374521840226160",
      number: "37452",
      supplierId: "F08",
      items: [{ sku: "SKU-1025", description: "Macarrão espaguete 500 g", quantity: { amount: 232, unit: "CX" } }],
      status: { kind: "acao", action: { kind: "receber" }, publishedAt: "2026-11-12T09:00:00Z" },
    },
    {
      invoiceAccessKey: "35261154813096000149550010000706331730119123",
      number: "70633",
      supplierId: "F05",
      items: [{ sku: "SKU-1016", description: "Feijão carioca 1 kg", quantity: { amount: 320, unit: "UN" } }],
      status: {
        kind: "acao",
        action: { kind: "receber_parcial", lines: [{ sku: "SKU-1016", quantity: { amount: 20, unit: "UN" }, disposition: "devolver" }] },
        publishedAt: "2026-11-12T09:10:00Z",
      },
    },
    {
      invoiceAccessKey: "35261153194517000138550010000844331298860518",
      number: "84433",
      supplierId: "F10",
      items: [{ sku: "SKU-1031", description: "Água sanitária 2 L", quantity: { amount: 12, unit: "UN" } }],
      status: { kind: "aguardando_aprovacao", instrucao: "Aguardando aprovação, não descarregue" },
    },
  ],
};

describe("#135 /recebimento/loja", () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json(board));
  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  function renderLoja() {
    window.history.replaceState(null, "", "/recebimento/loja");
    return render(<Frame context={fallbackContext("loja@barte.com")} />);
  }

  it("#135/AC-2 lê /api/recebimento-loja e lista as notas da loja com a ação de cada uma", async () => {
    renderLoja();
    expect(await screen.findByRole("heading", { name: "Recebimento na loja" })).toBeTruthy();
    expect(await screen.findByText("NF 37452")).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/recebimento-loja");
    const row = screen.getByText("NF 37452").closest("tr")!;
    expect(within(row).getByText("Receber")).toBeTruthy();
    expect(within(row).getByText("Receba tudo no app")).toBeTruthy();
    expect(within(screen.getByText("NF 70633").closest("tr")!).getByText("Devolva 20 UN de SKU-1016")).toBeTruthy();
  });

  it("#135/AC-3 nenhum texto da tela chama de doca o recebimento da loja", async () => {
    renderLoja();
    await screen.findByText("NF 84433");
    expect(within(screen.getByText("NF 84433").closest("tr")!).getByText("Não receba ainda")).toBeTruthy();
    expect(document.querySelector("main")?.textContent ?? "").not.toMatch(/doca|caminh/i);
  });

  it("#135 a navegação Recebimento tem Doca (CD) e Loja", () => {
    const group = NAVIGATION.find((g) => g.key === "recebimento")!;
    expect(group.items.map((i) => [i.label, i.href])).toEqual([
      ["Doca (CD)", "/doca"],
      ["Loja", "/recebimento/loja"],
    ]);
  });
});
