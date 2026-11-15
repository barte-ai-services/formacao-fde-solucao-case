import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, me } from "../src/api/client";

afterEach(() => vi.unstubAllGlobals());

describe("cliente da API", () => {
  it("GET /me vai na mesma origem, com o cookie do Access", async () => {
    const fetchMock = vi.fn(async () => Response.json({ email: "aluna@barte.com" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await me()).toEqual({ email: "aluna@barte.com" });
    expect(fetchMock).toHaveBeenCalledWith("/me", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  });

  it("401 e 403 viram ApiError tratável, com o código do corpo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unauthenticated" }, { status: 401 })));
    const error = await apiGet("/api/fila").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).code).toBe("unauthenticated");
    expect((error as ApiError).isUnauthorized).toBe(true);
  });

  it("falha de rede vira ApiError com status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("rede"))));
    const error = await apiGet("/api/fila").catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(0);
  });
});
