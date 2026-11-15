import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAccessVerifier, type FetchJwks } from "../src/http/access";
import { createWorker } from "../src/index";
import type { Env } from "../src/env";

const TEAM = "barte-academy.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const AUD = "aud-da-aplicacao";
const CERTS = `${ISS}/cdn-cgi/access/certs`;
const EMAIL = "aluna@barte.com";

const env: Env = { ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM };
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

const ALG = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

let key: CryptoKeyPair;
let otherKey: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

beforeAll(async () => {
  key = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  otherKey = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", key.publicKey)) as JsonWebKey), kid: "kid-1" };
});

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8b64url(text: string): string {
  return b64url(String.fromCharCode(...new TextEncoder().encode(text)));
}

const now = () => Math.floor(Date.now() / 1000);

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { aud: [AUD], iss: ISS, email: EMAIL, iat: now(), nbf: now() - 5, exp: now() + 300, ...overrides };
}

async function sign(
  payload: Record<string, unknown>,
  options: { kid?: string; alg?: string; signer?: CryptoKey } = {},
): Promise<string> {
  const header = { alg: options.alg ?? "RS256", kid: options.kid ?? "kid-1", typ: "JWT" };
  const input = `${utf8b64url(JSON.stringify(header))}.${utf8b64url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(ALG.name, options.signer ?? key.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

function fakeJwks(keys: () => unknown[] = () => [jwk]) {
  return vi.fn<FetchJwks>(async () => ({ keys: keys() }));
}

function workerWith(fetchJwks: FetchJwks, nowMs?: () => number) {
  return createWorker({ verifier: createAccessVerifier(fetchJwks, nowMs ? { now: nowMs } : {}) });
}

async function call(
  path: string,
  options: { token?: string; cookie?: string; env?: Env; fetchJwks?: FetchJwks; method?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", options.token);
  if (options.cookie !== undefined) headers.set("Cookie", options.cookie);
  const worker = workerWith(options.fetchJwks ?? fakeJwks());
  const request = new Request(`https://worker.test${path}`, { method: options.method ?? "GET", headers });
  return worker.fetch(request, options.env ?? env, ctx);
}

describe("Cloudflare Access no Worker", () => {
  it("#54/AC-1 requisição sem JWT recebe 401", async () => {
    const response = await call("/me");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("#54/AC-2 JWT com AUD errado recebe 403", async () => {
    const response = await call("/me", { token: await sign(claims({ aud: ["outra-aplicacao"] })) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("#54/AC-3 JWT válido recebe 200 em /me com o e-mail", async () => {
    const response = await call("/me", { token: await sign(claims()) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: EMAIL });
  });

  it("aceita aud como string", async () => {
    const response = await call("/me", { token: await sign(claims({ aud: AUD })) });
    expect(response.status).toBe(200);
  });

  it("aceita o token no cookie CF_Authorization", async () => {
    const token = await sign(claims());
    const response = await call("/me", { cookie: `outro=1; CF_Authorization=${token}; mais=2` });
    expect(response.status).toBe(200);
  });

  it("aceita o domínio do time com https:// e barra no fim", async () => {
    const fetchJwks = fakeJwks();
    const response = await call("/me", {
      token: await sign(claims()),
      env: { ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: `https://${TEAM}/` },
      fetchJwks,
    });
    expect(response.status).toBe(200);
    expect(fetchJwks).toHaveBeenCalledWith(CERTS);
  });

  const invalid: [string, () => Promise<string>][] = [
    ["expirado", () => sign(claims({ exp: now() - 120 }))],
    ["sem exp", () => sign(claims({ exp: undefined }))],
    ["ainda não válido (nbf no futuro)", () => sign(claims({ nbf: now() + 600 }))],
    ["emissor errado", () => sign(claims({ iss: "https://outro.cloudflareaccess.com" }))],
    ["assinado por outra chave", () => sign(claims(), { signer: otherKey.privateKey })],
    ["kid desconhecido", () => sign(claims(), { kid: "kid-que-nao-existe" })],
    ["algoritmo que não é RS256", () => sign(claims(), { alg: "HS256" })],
    ["malformado", async () => "nao.e.um-jwt"],
    ["com partes demais", async () => `${await sign(claims())}.extra`],
  ];
  for (const [name, token] of invalid) {
    it(`JWT ${name} recebe 403 sem dizer o motivo`, async () => {
      const value = await token();
      const response = await call("/me", { token: value });
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ error: "forbidden" });
      expect(body).not.toContain(value);
    });
  }

  it("aceita relógio adiantado em até 60s", async () => {
    const response = await call("/me", { token: await sign(claims({ exp: now() - 30, nbf: now() + 30 })) });
    expect(response.status).toBe(200);
  });

  for (const [name, broken] of [
    ["sem AUD", { ACCESS_TEAM_DOMAIN: TEAM }],
    ["sem domínio do time", { ACCESS_AUD: AUD }],
    ["com valores vazios", { ACCESS_AUD: "", ACCESS_TEAM_DOMAIN: "" }],
    ["com domínio que não é um host", { ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: "evil.com/path" }],
  ] as [string, Env][]) {
    it(`configuração ${name} com token fecha com 503`, async () => {
      const fetchJwks = fakeJwks();
      const response = await call("/me", { token: await sign(claims()), env: broken, fetchJwks });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "access_not_configured" });
      expect(fetchJwks).not.toHaveBeenCalled();
    });
  }

  it("falha ao buscar as chaves responde 503 sem guardar a falha", async () => {
    let fail = true;
    const fetchJwks = vi.fn<FetchJwks>(async () => {
      if (fail) throw new Error("rede fora");
      return { keys: [jwk] };
    });
    const worker = workerWith(fetchJwks);
    const request = async () =>
      worker.fetch(
        new Request("https://worker.test/me", { headers: { "Cf-Access-Jwt-Assertion": await sign(claims()) } }),
        env,
        ctx,
      );
    const first = await request();
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: "access_unavailable" });
    fail = false;
    expect((await request()).status).toBe(200);
  });

  it("guarda as chaves em cache entre requisições", async () => {
    const fetchJwks = fakeJwks();
    const worker = workerWith(fetchJwks);
    for (let i = 0; i < 3; i++) {
      const token = await sign(claims());
      const response = await worker.fetch(
        new Request("https://worker.test/me", { headers: { "Cf-Access-Jwt-Assertion": token } }),
        env,
        ctx,
      );
      expect(response.status).toBe(200);
    }
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("busca as chaves de novo depois do TTL e quando aparece um kid novo", async () => {
    let clock = Date.now();
    let keys: unknown[] = [];
    const fetchJwks = fakeJwks(() => keys);
    const worker = workerWith(fetchJwks, () => clock);
    const request = async () =>
      worker.fetch(
        new Request("https://worker.test/me", {
          headers: { "Cf-Access-Jwt-Assertion": await sign(claims({ nbf: undefined, exp: clock / 1000 + 300 })) },
        }),
        env,
        ctx,
      );

    expect((await request()).status).toBe(403); // cache com chave nenhuma
    keys = [jwk];
    expect((await request()).status).toBe(403); // kid desconhecido, mas a última busca é recente demais
    clock += 31_000;
    expect((await request()).status).toBe(200); // kid desconhecido: busca de novo uma vez
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    clock += 11 * 60_000;
    expect((await request()).status).toBe(200); // TTL vencido: renova
    expect(fetchJwks).toHaveBeenCalledTimes(3);
  });

  it("sem token recebe 401 mesmo sem o Access configurado", async () => {
    const response = await call("/me", { env: {} });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("/health continua aberto sem token", async () => {
    const response = await call("/health", { env: {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("rota desconhecida sem token recebe 401, não 404", async () => {
    expect((await call("/nao-existe")).status).toBe(401);
  });

  it("rota desconhecida com token válido recebe 404", async () => {
    expect((await call("/nao-existe", { token: await sign(claims()) })).status).toBe(404);
  });

  it("caminho com nome de propriedade herdada e token válido recebe 404", async () => {
    expect((await call("/constructor", { token: await sign(claims()) })).status).toBe(404);
  });

  it("método não aceito em /me com token válido recebe 405", async () => {
    const response = await call("/me", { token: await sign(claims()), method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("não registra nada em log ao negar", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    await call("/me", { token: await sign(claims({ aud: ["x"] })) });
    await call("/me", { token: "lixo" });
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
