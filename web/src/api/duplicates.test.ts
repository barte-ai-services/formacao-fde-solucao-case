import { afterEach, describe, expect, it, vi } from "vitest";
import { duplicatesApi } from "./duplicates";

// #160 As duplicadas no fio paginado: o caminho, a chave da linha e os agregados da lista inteira.

afterEach(() => vi.unstubAllGlobals());

const entry = (accessKey: string) => ({
  duplicate: { accessKey, number: "1", supplierId: "FORN-07", issuedOn: "2026-11-10", totalCents: 100, total: "R$ 1,00" },
  original: null,
  reason: "ordem_sem_saldo",
  titleState: null,
  blockedAmountCents: 100,
  blockedAmount: "R$ 1,00",
});
const aggregates = { blockedAmount: { cents: 200, text: "R$ 2,00" }, byReason: { titulo_lancado: 0, ordem_sem_saldo: 2 } };

describe("#160 duplicatesApi.page", () => {
  it("#160: lê /api/duplicates com `limite` e a chave de cada linha é a da nota duplicada", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ items: [entry("d1"), entry("d2")], nextCursor: "c2", total: 65, aggregates }));
    vi.stubGlobal("fetch", fetchMock);
    const block = await duplicatesApi.page("c1", new AbortController().signal);
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://web.test");
    expect(url.pathname).toBe("/api/duplicates"); // ADR-004
    expect(url.searchParams.get("limite")).toBe("30"); // ADR-006
    expect(url.searchParams.get("cursor")).toBe("c1");
    expect(block.items.map((row) => row.key)).toEqual(["d1", "d2"]);
    expect(block.items[0]?.duplicate.accessKey).toBe("d1");
    expect(block.nextCursor).toBe("c2");
    expect(block.total).toBe(65);
    expect(block.aggregates).toEqual(aggregates);
  });
});
