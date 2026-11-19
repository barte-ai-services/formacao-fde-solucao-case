import { afterEach, describe, expect, it, vi } from "vitest";
import { dockApi } from "./dock";

// #160 A doca e o recebimento na loja no fio paginado: o caminho e o filtro de cada um, e o destino que a tela lê junto dos agregados.

afterEach(() => vi.unstubAllGlobals());

const row = (invoiceAccessKey: string) => ({ invoiceAccessKey, number: "7", supplierId: "F08", items: [], status: { kind: "aguardando_aprovacao", instrucao: "x" }, decidedBy: null });
const page = { destination: "CD-03", date: "2026-11-11", destinations: ["CD-03", "CD-04"], items: [row("r1"), row("r2")], nextCursor: null, total: 2, aggregates: { awaiting: 2 } };

function serve() {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json(page));
  vi.stubGlobal("fetch", fetchMock);
  return () => new URL(String(fetchMock.mock.calls[0]![0]), "http://web.test");
}
const signal = new AbortController().signal;

describe("#160 dockApi", () => {
  it("#160: boardPage junta o destino e a lista de destinos aos agregados, e a chave da linha é a da nota", async () => {
    const requested = serve();
    const block = await dockApi.boardPage("CD-03", "c1", signal);
    const url = requested();
    expect(url.pathname).toBe("/api/doca"); // ADR-004
    expect(url.searchParams.get("destino")).toBe("CD-03"); // ADR-004
    expect(url.searchParams.get("limite")).toBe("30"); // ADR-006
    expect(url.searchParams.get("cursor")).toBe("c1");
    expect(block.aggregates).toEqual({ awaiting: 2, destination: "CD-03", destinations: ["CD-03", "CD-04"] });
    expect(block.items.map((r) => r.key)).toEqual(["r1", "r2"]);
    expect(block.total).toBe(2);
  });

  it("#160: sem destino a doca não manda `destino`, e a API abre no primeiro", async () => {
    const requested = serve();
    await dockApi.boardPage(null, null, signal);
    expect(requested().searchParams.has("destino")).toBe(false); // ADR-004
  });

  it("#160: o recebimento na loja lê /api/recebimento-loja com `loja` e traz os mesmos agregados", async () => {
    const requested = serve();
    const block = await dockApi.storePage("LJ-012", null, signal);
    const url = requested();
    expect(url.pathname).toBe("/api/recebimento-loja"); // ADR-004
    expect(url.searchParams.get("loja")).toBe("LJ-012"); // ADR-004
    expect(block.aggregates.destinations).toEqual(["CD-03", "CD-04"]);
  });
});
