import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { fallbackContext } from "../src/shell/context";

// #72 A tela da doca contra uma API falsa, no formato de api/src/dock/dock-board.ts. Notas do kit: CD-03 em 2026-11-11.

const board = {
  destination: "CD-03",
  date: "2026-11-11",
  destinations: ["CD-03", "LJ-012"],
  awaiting: 1,
  rows: [
    {
      invoiceAccessKey: "K1",
      number: "43901",
      supplierId: "F02",
      items: [{ sku: "SKU-1", description: "Arroz 5kg", quantity: { amount: 12, unit: "CX" } }],
      status: { kind: "acao", action: { kind: "receber" }, publishedAt: "2026-11-11T09:00:00Z" },
    },
    {
      invoiceAccessKey: "K2",
      number: "43902",
      supplierId: "F05",
      items: [{ sku: "SKU-2", description: "Feijão 1kg", quantity: { amount: 10, unit: "CX" } }],
      status: {
        kind: "acao",
        action: {
          kind: "receber_parcial",
          lines: [
            { sku: "SKU-2", quantity: { amount: 2, unit: "CX" }, disposition: "devolver" },
            { sku: "SKU-3", quantity: { amount: 1, unit: "UN" }, disposition: "segurar" },
          ],
        },
        publishedAt: "2026-11-11T09:10:00Z",
      },
    },
    {
      invoiceAccessKey: "K3",
      number: "43903",
      supplierId: "F07",
      items: [{ sku: "SKU-4", description: "Óleo 900ml", quantity: { amount: 6, unit: "CX" } }],
      status: { kind: "aguardando_aprovacao", instrucao: "Aguardando aprovação, não descarregue" },
    },
  ],
};

describe("#72 /doca", () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json(board));
  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  function renderDoca() {
    window.history.replaceState(null, "", "/doca");
    return render(<Frame context={fallbackContext("doca@barte.com")} />);
  }

  it("#43/AC-4 lista as notas do dia do destino com a ação de cada uma", async () => {
    renderDoca();
    expect(await screen.findByText("NF 43901")).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/doca");
    const row = (n: string) => screen.getByText(`NF ${n}`).closest("tr")!;
    expect(within(row("43901")).getByText("Receber")).toBeTruthy();
    expect(within(row("43901")).getByText("Descarregue tudo")).toBeTruthy();
  });

  it("#43/AC-2 receber parcial diz o que segurar e o que devolver", async () => {
    renderDoca();
    const row = (await screen.findByText("NF 43902")).closest("tr")!;
    expect(within(row).getByText("Receber parcial")).toBeTruthy();
    expect(within(row).getByText("Segure 1 UN de SKU-3; Devolva 2 CX de SKU-2")).toBeTruthy();
  });

  it("#43/AC-3 nota sem decisão aparece como aguardando aprovação, nunca como receber", async () => {
    renderDoca();
    const row = (await screen.findByText("NF 43903")).closest("tr")!;
    expect(within(row).getByText("Aguardando aprovação")).toBeTruthy();
    expect(within(row).getByText("Não descarregue ainda")).toBeTruthy();
    expect(within(row).queryByText("Receber")).toBeNull();
    expect(screen.getByText("1 nota aguarda aprovação.")).toBeTruthy();
  });
});
