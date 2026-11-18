import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, me } from "../src/api/client";
import { approvalApi, type AuditDto } from "../src/api/approval";

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

// #231 O contrato da auditoria na proposta: `GET /api/propostas/:chave` traz `audit`, e o cliente o entrega como a API o mandou.
describe("#231 a auditoria na proposta (contrato)", () => {
  const KEY = "35261100000000000000550010000080001000080001";
  const served = (audit: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ number: "80", ...(audit === undefined ? {} : { audit }) })));

  it("#231/AC-1 a auditada chega inteira, com a concordância", async () => {
    const audit: AuditDto = {
      status: "auditada",
      classification: "E4",
      dockAction: { kind: "receber" },
      routing: "coordenacao",
      justification: "A ordem confirma.\nO preço bate.",
      amountAtRisk: { cents: 0, text: "R$ 0,00" },
      model: "claude-exemplo",
      auditedAt: "2026-11-15T17:32:00Z",
      agreement: { agrees: true },
      raisedLevel: null,
      injectionFlag: null,
      refusals: [],
    };
    served(audit);
    expect((await approvalApi.proposal(KEY)).audit).toEqual(audit);
  });

  it("#231/AC-5 a não auditada chega com o motivo", async () => {
    const audit: AuditDto = { status: "nao_auditada", reason: "sem_auditoria", refusals: [] };
    served(audit);
    expect((await approvalApi.proposal(KEY)).audit).toEqual(audit);
  });

  it("#231/AC-5 a auditoria nula chega nula, e o campo ausente chega ausente", async () => {
    served(null);
    expect((await approvalApi.proposal(KEY)).audit).toBeNull();
    served(undefined);
    expect((await approvalApi.proposal(KEY)).audit).toBeUndefined();
  });
});
