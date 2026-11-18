import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import type { ReadingListDto, SentRequestDetailDto } from "./contract";
import { CONFIRM_DOCUMENT_TIMEOUT_MS, ConfirmRereadFailed, FOLLOW_UP_SAVE_TIMEOUT_MS, FOLLOW_UP_SEND_TIMEOUT_MS, saveFailureOf, supplierReplyApi, supplierReplyReason } from "./supplier-reply";

// #21 O fio da lista "Pedidos ao fornecedor" (#5): o filtro vai na consulta, as contagens são do servidor, e o erro vira motivo fechado.

const KEY = "35261100000000000000550010000200461000200461";
const BASE = `/api/supplier-requests/${KEY}`;

const LIST: ReadingListDto = {
  filter: "overdue",
  requests: [],
  counts: { awaiting: 1, answered: 0, needs_you: 0, overdue: 2 },
};

const SENT = {
  status: "sent",
  invoiceAccessKey: KEY,
  requestType: "return_note",
  returnNote: { number: "ND-7", supplier: "F07", reference: "59738", lines: [], total: { text: "R$ 263,62" } },
  email: { to: "financeiro@f07.example", dueOn: "2026-11-14", subject: "Assunto", body: "Texto", template: "Texto" },
  asks: [],
  sentBy: "analista@barte.com",
  sentAt: "2026-11-07T12:40:00.000Z",
  reading: null,
  documentConfirmation: null,
  followUp: { drafted: true, sent: false, draft: { subject: "Cobrança", body: "Olá", template: "Olá", asks: [] }, sentBy: null, sentAt: null, failure: null, dueOn: "2026-11-19" },
} satisfies SentRequestDetailDto;

let calls: { method: string; path: string; body: unknown }[] = [];

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

describe("#21 fio da lista dos pedidos ao fornecedor", () => {
  it("#5/AC-2: list pede o filtro pela consulta e devolve as linhas e as contagens do servidor", async () => {
    serve(() => Response.json(LIST));
    expect(await supplierReplyApi.list("overdue", new AbortController().signal)).toEqual(LIST);
    expect(calls).toEqual([{ method: "GET", path: "/api/supplier-requests?status=overdue", body: undefined }]);
  });

  it("#5/AC-3: detail lê o pedido pela chave de acesso e devolve o pedido enviado", async () => {
    serve(() => Response.json({ request: SENT }));
    expect(await supplierReplyApi.detail(KEY, new AbortController().signal)).toEqual(SENT);
    expect(calls).toEqual([{ method: "GET", path: BASE, body: undefined }]);
  });

  it("#5/AC-3: sem pedido, ou com um pedido que não está enviado, a carga da gaveta falha", async () => {
    for (const request of [null, { status: "draft" }, { status: "writing" }]) {
      serve(() => Response.json({ request }));
      await expect(supplierReplyApi.detail(KEY, new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
    }
  });

  it("#5/AC-4: sendFollowUp é um POST com corpo vazio no .../send e devolve o pedido como ficou", async () => {
    const after = { ...SENT, followUp: { ...SENT.followUp, sent: true, sentBy: "analista@barte.com", sentAt: "2026-11-15T13:12:00.000Z" } };
    serve(() => Response.json({ request: after }));
    expect(await supplierReplyApi.sendFollowUp(KEY)).toEqual(after);
    expect(calls).toEqual([{ method: "POST", path: `${BASE}/send`, body: {} }]);
  });

  it("#5/AC-4: um 409 no envio (já enviado) relê o pedido e devolve como o servidor o tem, com followUp.sent", async () => {
    const sent = { ...SENT, followUp: { ...SENT.followUp, sent: true, sentAt: "2026-11-15T13:12:00.000Z" } };
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({ method: init.method ?? "GET", path: String(input), body: undefined });
        return init.method === "POST" ? Response.json({ error: "conflict", reason: "already_sent" }, { status: 409 }) : Response.json({ request: sent });
      }),
    );
    expect(await supplierReplyApi.sendFollowUp(KEY)).toEqual(sent);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${BASE}/send`, `GET ${BASE}`]);
  });

  it("#5/AC-4: um 409 em que o pedido não consta enviado (envio em curso) devolve o pedido sem followUp.sent; outro erro segue como erro", async () => {
    serve(() => Response.json({ request: SENT }));
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => (init.method === "POST" ? Response.json({ error: "conflict" }, { status: 409 }) : Response.json({ request: SENT }))));
    expect((await supplierReplyApi.sendFollowUp(KEY)).followUp.sent).toBe(false);
    serve(() => Response.json({ error: "internal_error" }, { status: 500 }));
    await expect(supplierReplyApi.sendFollowUp(KEY)).rejects.toBeInstanceOf(ApiError);
  });

  it("#21: o envio da cobrança tem prazo próprio e termina como falha de rede (status 0) quando ele estoura", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const sending = supplierReplyApi.sendFollowUp(KEY);
    const outcome = sending.catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(FOLLOW_UP_SEND_TIMEOUT_MS + 1);
    const reason = await outcome;
    expect(reason).toBeInstanceOf(ApiError);
    expect((reason as ApiError).status).toBe(0);
  });

  it("#21: o motivo do erro sai só do status; o corpo e a mensagem da API não entram", () => {
    const body = "texto cru da dependência";
    expect(supplierReplyReason(new ApiError(401, null, body))).toBe("unauthorized");
    expect(supplierReplyReason(new ApiError(403, "forbidden", body))).toBe("unauthorized");
    expect(supplierReplyReason(new ApiError(404, "not_found", body))).toBe("not_found");
    expect(supplierReplyReason(new ApiError(409, "conflict", body))).toBe("conflict");
    expect(supplierReplyReason(new ApiError(422, "invalid", body))).toBe("conflict");
    expect(supplierReplyReason(new ApiError(502, "supabase_unavailable", body))).toBe("unavailable");
    expect(supplierReplyReason(new ApiError(0, null, body))).toBe("unavailable");
    expect(supplierReplyReason(new ApiError(500, "internal_error", body))).toBe("unknown");
    expect(supplierReplyReason(new TypeError(body))).toBe("unknown");
  });
});

// #59 O PATCH da cobrança: troca só o texto (o molde com {{...}}); o 422 e o 409 viram motivo fechado, e a chamada tem prazo.
describe("#59 fio da edição da cobrança", () => {
  it("#59/AC-2: saveFollowUp é um PATCH em .../follow-up com o molde e devolve o pedido como ficou, com o rascunho novo", async () => {
    const after = { ...SENT, followUp: { ...SENT.followUp, draft: { subject: "Cobrança", body: "Novo 20/11", template: "Novo {{cobranca.prazo}}", asks: [] } } };
    serve(() => Response.json({ request: after }));
    expect(await supplierReplyApi.saveFollowUp(KEY, "Novo {{cobranca.prazo}}")).toEqual({ kind: "saved", detail: after });
    expect(calls).toEqual([{ method: "PATCH", path: `${BASE}/follow-up`, body: { template: "Novo {{cobranca.prazo}}" } }]);
  });

  it("#59/AC-2: o 422 (número solto, forma inválida) falha como ApiError 422, e o motivo fechado é 'invalid'", async () => {
    serve(() => Response.json({ error: "invalid", reason: "number_mismatch", field: "body" }, { status: 422 }));
    const reason = await supplierReplyApi.saveFollowUp(KEY, "263,62").catch((error: unknown) => error);
    expect(reason).toBeInstanceOf(ApiError);
    expect((reason as ApiError).status).toBe(422);
    expect(saveFailureOf(reason)).toBe("invalid");
  });

  it("#59: um 409 (já enviado, envio em curso, sem rascunho, stale) relê o pedido e devolve como conflito", async () => {
    const sent = { ...SENT, followUp: { ...SENT.followUp, sent: true, draft: null, sentAt: "2026-11-15T13:12:00.000Z" } };
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({ method: init.method ?? "GET", path: String(input), body: undefined });
        return init.method === "PATCH" ? Response.json({ error: "conflict", reason: "already_sent" }, { status: 409 }) : Response.json({ request: sent });
      }),
    );
    expect(await supplierReplyApi.saveFollowUp(KEY, "x {{cobranca.prazo}}")).toEqual({ kind: "conflict", detail: sent });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`PATCH ${BASE}/follow-up`, `GET ${BASE}`]);
  });

  it("#59: o motivo do salvamento sai só do status: 422 'invalid', 409 'conflict', o resto 'unknown'; o texto do erro não entra", () => {
    const body = "texto cru da dependência";
    expect(saveFailureOf(new ApiError(422, "invalid", body))).toBe("invalid");
    expect(saveFailureOf(new ApiError(409, "conflict", body))).toBe("conflict");
    expect(saveFailureOf(new ApiError(500, "internal_error", body))).toBe("unknown");
    expect(saveFailureOf(new ApiError(0, null, body))).toBe("unknown");
    expect(saveFailureOf(new TypeError(body))).toBe("unknown");
  });

  it("#59: o salvamento tem prazo próprio e termina como falha de rede (status 0) quando ele estoura", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const outcome = supplierReplyApi.saveFollowUp(KEY, "x").catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(FOLLOW_UP_SAVE_TIMEOUT_MS + 1);
    const reason = await outcome;
    expect(reason).toBeInstanceOf(ApiError);
    expect((reason as ApiError).status).toBe(0);
  });

  it("#59: o envio que o servidor recusa por texto trocado no meio (409 stale) relê o pedido, com o texto novo, e nada saiu", async () => {
    const changed = { ...SENT, followUp: { ...SENT.followUp, draft: { subject: "Cobrança", body: "Texto novo", template: "Texto novo", asks: [] } } };
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => (init.method === "POST" ? Response.json({ error: "conflict", reason: "stale" }, { status: 409 }) : Response.json({ request: changed }))));
    const reread = await supplierReplyApi.sendFollowUp(KEY);
    expect(reread.followUp.sent).toBe(false);
    expect(reread.followUp.draft?.body).toBe("Texto novo");
  });
});

describe("#64 fio da confirmação do documento citado", () => {
  const CONFIRMATION = { document: "NF-D 881", by: "analista@barte.com", at: "2026-11-17T13:05:00.000Z" };
  const CONFIRMED = { ...SENT, documentConfirmation: CONFIRMATION };

  it("#64/AC-2: confirmDocument é um POST de corpo {} no .../confirm-document e devolve o pedido como ficou, com quem confirmou e quando", async () => {
    serve(() => Response.json({ request: CONFIRMED }));
    expect(await supplierReplyApi.confirmDocument(KEY)).toEqual({ kind: "confirmed", detail: CONFIRMED });
    expect(calls).toEqual([{ method: "POST", path: `${BASE}/confirm-document`, body: {} }]);
  });

  it("#64/AC-2: um 409 (já confirmado, ou o pedido mudou) relê o pedido e o devolve como conflito; o corpo do 409 não é lido", async () => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({ method: init.method ?? "GET", path: String(input), body: undefined });
        return init.method === "POST" ? Response.json({ error: "conflict", reason: "already_confirmed", detail: "texto cru" }, { status: 409 }) : Response.json({ request: CONFIRMED });
      }),
    );
    expect(await supplierReplyApi.confirmDocument(KEY)).toEqual({ kind: "conflict", detail: CONFIRMED });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${BASE}/confirm-document`, `GET ${BASE}`]);
  });

  it("#64/AC-2: 403, 404 e 5xx seguem como erro (sem reler), para a tela tirar o motivo fechado do status", async () => {
    for (const status of [403, 404, 500, 502]) {
      serve(() => Response.json({ error: "x", correlationId: "c-1" }, { status }));
      await expect(supplierReplyApi.confirmDocument(KEY)).rejects.toMatchObject({ status });
      expect(calls).toHaveLength(1);
    }
  });

  it("#64/AC-2: a chamada tem prazo próprio e termina como falha de rede (status 0) quando ele estoura", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const outcome = supplierReplyApi.confirmDocument(KEY).catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(CONFIRM_DOCUMENT_TIMEOUT_MS + 1);
    const reason = await outcome;
    expect(reason).toBeInstanceOf(ApiError);
    expect((reason as ApiError).status).toBe(0);
  });

  it("#64/AC-2: uma resposta 200 que não é o pedido enviado falha a chamada, em vez de mostrar o que não se sabe", async () => {
    serve(() => Response.json({ request: { status: "draft" } }));
    await expect(supplierReplyApi.confirmDocument(KEY)).rejects.toBeInstanceOf(ApiError);
  });

  it("#64: 409 já confirmado e a releitura falha: o motivo fechado 'already_confirmed' sai, sem o corpo nem o texto do erro", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) =>
        init.method === "POST" ? Response.json({ error: "conflict", reason: "already_confirmed", detail: "texto cru" }, { status: 409 }) : Response.json({ error: "x" }, { status: 503 }),
      ),
    );
    const failure = await supplierReplyApi.confirmDocument(KEY).catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(ConfirmRereadFailed);
    expect(failure).toMatchObject({ reason: "already_confirmed" });
    expect(String((failure as Error).message)).not.toContain("texto cru");
  });

  it("#64: 409 de outro motivo (ou um que a tela não conhece) e a releitura falha: o motivo fechado é 'other'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) =>
        init.method === "POST" ? Response.json({ error: "conflict", reason: "<b>stale?</b>" }, { status: 409 }) : Response.json({ error: "x" }, { status: 503 }),
      ),
    );
    const failure = await supplierReplyApi.confirmDocument(KEY).catch((reason: unknown) => reason);
    expect(failure).toMatchObject({ reason: "other" });
    expect(String((failure as Error).message)).not.toContain("<b>");
  });
});
