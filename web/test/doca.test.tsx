import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { pagedBody } from "./paged-fixture";
import { fallbackContext } from "../src/shell/context";

// #72 A tela da doca contra uma API falsa, no formato de api/src/dock/dock-board.ts. As notas são do kit (data/kit/notas.json): CD-03 em 2026-11-11; as ações são as do cenário de cada AC.

const board = {
  destination: "CD-03",
  date: "2026-11-11",
  destinations: ["CD-03", "CD-04"], // #135 a doca é só do CD
  awaiting: 1,
  rows: [
    {
      invoiceAccessKey: "35261162833783000154550010000374521840226160",
      number: "37452",
      supplierId: "F08",
      items: [{ sku: "SKU-1025", description: "Macarrão espaguete 500 g", quantity: { amount: 232, unit: "CX" } }],
      status: { kind: "acao", action: { kind: "receber" }, publishedAt: "2026-11-11T09:00:00Z" },
    },
    {
      invoiceAccessKey: "35261154813096000149550010000706331730119123",
      number: "70633",
      supplierId: "F05",
      items: [{ sku: "SKU-1016", description: "Feijão carioca 1 kg", quantity: { amount: 320, unit: "UN" } }],
      status: {
        kind: "acao",
        action: {
          kind: "receber_parcial",
          lines: [
            { sku: "SKU-1016", quantity: { amount: 20, unit: "UN" }, disposition: "devolver" },
            { sku: "SKU-1017", quantity: { amount: 16, unit: "UN" }, disposition: "segurar" },
          ],
        },
        publishedAt: "2026-11-11T09:10:00Z",
      },
    },
    {
      invoiceAccessKey: "35261153194517000138550010000844331298860518",
      number: "84433",
      supplierId: "F10",
      items: [{ sku: "SKU-1031", description: "Água sanitária 2 L", quantity: { amount: 1536, unit: "UN" } }],
      status: { kind: "aguardando_aprovacao", instrucao: "Aguardando aprovação, não descarregue" },
    },
  ],
};

describe("#72 /doca", () => {
  // #160 A API responde em blocos: a lista cabe num só (`nextCursor` nulo), e `awaiting` vem dos agregados.
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => Response.json(pagedBody(String(input), board)));
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
    expect(await screen.findByText("NF 37452")).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/doca?limite=30");
    const row = (n: string) => screen.getByText(`NF ${n}`).closest("tr")!;
    expect(within(row("37452")).getByText("Receber")).toBeTruthy();
    expect(within(row("37452")).getByText("Descarregue tudo")).toBeTruthy();
  });

  it("#43/AC-2 receber parcial diz o que segurar e o que devolver", async () => {
    renderDoca();
    const row = (await screen.findByText("NF 70633")).closest("tr")!;
    expect(within(row).getByText("Receber parcial")).toBeTruthy();
    expect(within(row).getByText("Segure 16 UN de SKU-1017; Devolva 20 UN de SKU-1016")).toBeTruthy();
  });

  it("#43/AC-3 nota sem decisão aparece como aguardando aprovação, nunca como receber", async () => {
    renderDoca();
    const row = (await screen.findByText("NF 84433")).closest("tr")!;
    expect(within(row).getByText("Aguardando aprovação")).toBeTruthy();
    expect(within(row).getByText("Não descarregue ainda")).toBeTruthy();
    expect(within(row).queryByText("Receber")).toBeNull();
    expect(screen.getByText("1 nota aguarda aprovação.")).toBeTruthy();
  });
});
