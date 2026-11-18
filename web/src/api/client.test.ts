import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiPatch, apiPost, DEFAULT_TIMEOUT_MS } from "./client";

// #17 O prazo das chamadas (REL-1, da revisão da #37): uma chamada parada termina em falha, nunca fica pendurada.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** #17 Um fetch que nunca responde e só termina quando o sinal aborta, como o do navegador. */
function stalledFetch() {
  return vi.fn(
    (_path: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
}

describe("#17 cliente da API: prazo e PATCH", () => {
  it("#17/AC-6: a chamada parada termina em ApiError de status 0 quando o prazo padrão passa", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stalledFetch());
    const outcome = apiPost("/api/supplier-requests/x/send", {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    const error = await outcome;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
  });

  it("#17/AC-6: o prazo pode ser trocado por chamada", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stalledFetch());
    const outcome = apiGet("/api/supplier-requests/x", { timeoutMs: 50 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(((await outcome) as ApiError).status).toBe(0);
  });

  it("#17/AC-6: quem cancela com o próprio sinal continua recebendo o cancelamento, não uma falha", async () => {
    vi.stubGlobal("fetch", stalledFetch());
    const controller = new AbortController();
    const outcome = apiGet("/api/supplier-requests/x", { signal: controller.signal }).catch((e: unknown) => e);
    // #17 O motivo vai explícito, do mesmo DOMException do ambiente: o jsdom e o Node têm um DOMException cada, e o motivo que o AbortController do Node cria sozinho não é o `DOMException` global do jsdom (no navegador há um só).
    controller.abort(new DOMException("cancelado por quem chamou", "AbortError"));
    const error = await outcome;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("#17/AC-6: PATCH manda o corpo em JSON, na mesma origem", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await apiPatch("/api/supplier-requests/x", { template: "Texto {{a}}" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/supplier-requests/x",
      expect.objectContaining({ method: "PATCH", credentials: "same-origin", body: JSON.stringify({ template: "Texto {{a}}" }) }),
    );
  });
});
