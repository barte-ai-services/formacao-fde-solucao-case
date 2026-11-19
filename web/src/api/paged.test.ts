import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidCursorError } from "../components/paged-list-state";
import { ApiError } from "./client";
import { blockOf, getPage, PAGE_LIMIT } from "./paged";

// #160 O fio das listas paginadas: o que cada pedido leva na query e como a recusa do cursor sobe para o estado da lista.

afterEach(() => vi.unstubAllGlobals());

/** #160 Um fetch que responde `body` com `status` e guarda a URL pedida. */
function respond(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const requested = (fetchMock: ReturnType<typeof respond>): URL => new URL(String(fetchMock.mock.calls[0]![0]), "http://web.test");
const page = { items: [], nextCursor: null, total: 0, aggregates: {} };
const signal = new AbortController().signal;

describe("#160 getPage", () => {
  it("#160: o primeiro bloco leva `limite=30` e nenhum cursor", async () => {
    const fetchMock = respond(page);
    await getPage("/api/duplicates", [], null, signal); // ADR-004
    const url = requested(fetchMock);
    expect(PAGE_LIMIT).toBe(30);
    expect(url.pathname).toBe("/api/duplicates"); // ADR-004
    expect(url.searchParams.get("limite")).toBe("30"); // ADR-006
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  it("#160: do segundo bloco em diante o cursor vai na query, junto com `limite`", async () => {
    const fetchMock = respond(page);
    await getPage("/api/duplicates", [], "abc123", signal); // ADR-004
    const url = requested(fetchMock);
    expect(url.searchParams.get("cursor")).toBe("abc123");
    expect(url.searchParams.get("limite")).toBe("30"); // ADR-006
  });

  it("#160: os filtros da lista são repassados na query", async () => {
    const fetchMock = respond(page);
    await getPage("/api/doca", [["destino", "CD-03"], ["data", "2026-11-11"]], "c1", signal); // ADR-004
    const url = requested(fetchMock);
    expect(url.searchParams.get("destino")).toBe("CD-03"); // ADR-004
    expect(url.searchParams.get("data")).toBe("2026-11-11"); // ADR-004
    expect(url.searchParams.get("cursor")).toBe("c1");
  });

  it("#160: o 400 `cursor_invalido` vira InvalidCursorError, para a lista recomeçar", async () => {
    respond({ error: "cursor_invalido" }, 400); // ADR-006
    await expect(getPage("/api/duplicates", [], "velho", signal)).rejects.toBeInstanceOf(InvalidCursorError); // ADR-004
  });

  it("#160: outro 400 e os demais erros sobem como ApiError, com o código e sem o corpo", async () => {
    respond({ error: "invalid_query", detail: "segredo-do-servidor" }, 400);
    const error = await getPage("/api/duplicates", [], null, signal).catch((e: unknown) => e); // ADR-004
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid_query");
    expect((error as ApiError).message).not.toContain("segredo-do-servidor");
    respond({ error: "supabase_unavailable" }, 502);
    const down = await getPage("/api/duplicates", [], null, signal).catch((e: unknown) => e); // ADR-004
    expect((down as ApiError).status).toBe(502);
  });

  it("#160: o `cursor_invalido` com outro status não é o cursor recusado", async () => {
    respond({ error: "cursor_invalido" }, 500); // ADR-006
    await expect(getPage("/api/duplicates", [], "x", signal)).rejects.toBeInstanceOf(ApiError); // ADR-004
  });
});

describe("#160 blockOf", () => {
  it("#160: cada linha ganha a `key` pedida, e o cursor, o total e os agregados passam como vieram", () => {
    const block = blockOf({ items: [{ id: "a", n: 1 }, { id: "b", n: 2 }], nextCursor: "next", total: 70, aggregates: { all: 70 } }, (item) => `k-${item.id}`);
    expect(block.items).toEqual([{ id: "a", n: 1, key: "k-a" }, { id: "b", n: 2, key: "k-b" }]);
    expect(block.nextCursor).toBe("next");
    expect(block.total).toBe(70);
    expect(block.aggregates).toEqual({ all: 70 });
  });

  it("#160: no último bloco o cursor continua nulo", () => {
    expect(blockOf({ items: [], nextCursor: null, total: 0, aggregates: {} }, () => "x").nextCursor).toBeNull();
  });
});
