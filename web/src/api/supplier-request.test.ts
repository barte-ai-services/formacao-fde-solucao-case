import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, DEFAULT_TIMEOUT_MS } from "./client";
import { supplierRequestApi } from "./supplier-request";

// #156 O fio do pedido ao fornecedor: caminhos por chave de acesso, o corpo de cada ação e o que a tela recebe.

const KEY = "35261100000000000000550010000200461000200461";
const BASE = `/api/supplier-requests/${KEY}`;
const writing = { status: "writing" } as const;

let calls: { method: string; path: string; body: unknown }[] = [];

/** #156 Um fetch que nunca responde e só termina quando o sinal aborta, como o do navegador. */
function stalledFetch() {
  return vi.fn(
    (_path: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
}

function serve(response: () => Response): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? "GET", path: String(input), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return response();
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("#156 porta do pedido ao fornecedor sobre a API", () => {
  it("#156: load lê o pedido pela chave de acesso e devolve o que está em `request`", async () => {
    serve(() => Response.json({ request: writing }));
    expect(await supplierRequestApi.load(KEY, new AbortController().signal)).toEqual(writing);
    expect(calls).toEqual([{ method: "GET", path: BASE, body: undefined }]);
  });

  it("#156: sem pedido a API devolve request nulo, e a porta devolve nulo", async () => {
    serve(() => Response.json({ request: null }));
    expect(await supplierRequestApi.load(KEY, new AbortController().signal)).toBeNull();
  });

  it("#156: o contrato responde 200 com request nulo para a nota sem pedido; 404 e 500 são falha de carga", async () => {
    for (const status of [404, 500]) {
      serve(() => Response.json({ error: "falha" }, { status }));
      await expect(supplierRequestApi.load(KEY, new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
    }
  });

  it("#156 e AC-5: send, resend, discard e redo são POST com corpo vazio e devolvem o pedido", async () => {
    for (const action of ["send", "resend", "discard", "redo"] as const) {
      serve(() => Response.json({ request: writing }));
      expect(await supplierRequestApi[action](KEY)).toEqual(writing);
      expect(calls).toEqual([{ method: "POST", path: `${BASE}/${action}`, body: {} }]);
    }
  });

  it("#156: saveTemplate é PATCH com o molde em `template`", async () => {
    serve(() => Response.json({ request: writing }));
    await supplierRequestApi.saveTemplate(KEY, "Na NF {{numero}} veio {{item}}.");
    expect(calls).toEqual([{ method: "PATCH", path: BASE, body: { template: "Na NF {{numero}} veio {{item}}." } }]);
  });

  it("#156: 422 do PATCH chega como ApiError, para a tela mostrar a mensagem fixa", async () => {
    serve(() => Response.json({ error: "invalid", reason: "number_mismatch", field: "body" }, { status: 422 }));
    const error = await supplierRequestApi.saveTemplate(KEY, "Valor 99").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
  });

  // #156 Prazos por ação: o redo espera o Claude (até 45 s, api/src/claude/client.ts), o envio emite, grava e manda o e-mail.
  const DEADLINES = [
    ["send", 30_000],
    ["resend", 30_000],
    ["redo", 50_000],
    ["discard", DEFAULT_TIMEOUT_MS],
  ] as const;

  for (const [action, deadline] of DEADLINES) {
    it(`#156: ${action} que nunca responde termina em ApiError de status 0 aos ${deadline / 1000} s, nem antes`, async () => {
      vi.useFakeTimers();
      vi.stubGlobal("fetch", stalledFetch());
      let settled: unknown;
      void supplierRequestApi[action](KEY).catch((e: unknown) => {
        settled = e;
      });
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBeInstanceOf(ApiError);
      expect((settled as ApiError).status).toBe(0);
    });
  }
});
