/**
 * Validação do JWT do Cloudflare Access (#54), só com Web Crypto.
 *
 * O Access põe o token no cabeçalho `Cf-Access-Jwt-Assertion` (ou no cookie `CF_Authorization`).
 * O Worker confere a assinatura RS256 contra as chaves públicas do time, o `aud` da aplicação,
 * o `iss` do time e a validade. Nenhuma resposta e nenhum log dizem o motivo da recusa nem
 * repetem o token.
 */
import type { Env } from "../env";

/** Busca o JWKS do time. Injetável para os testes não tocarem a rede. */
export type FetchJwks = (url: string) => Promise<unknown>;

export interface AccessConfig {
  aud: string;
  teamDomain: string;
}

/** Quem passou pelo Access. `email` é nulo para um service token, que não tem e-mail. */
export interface Identity {
  email: string | null;
}

export type Verification =
  | { ok: true; identity: Identity }
  | { ok: false; reason: "invalid" | "unavailable" };

export interface AccessVerifier {
  verify(token: string, config: AccessConfig): Promise<Verification>;
}

const CLOCK_SKEW_S = 60;
const JWKS_TTL_MS = 10 * 60_000;
/** Intervalo mínimo entre buscas por kid desconhecido, para um kid inventado não virar enxurrada. */
const JWKS_MIN_REFETCH_MS = 30_000;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const TOKEN_HEADER = "Cf-Access-Jwt-Assertion";
const TOKEN_COOKIE = "CF_Authorization";
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

class Unavailable extends Error {}

/** Lê a configuração do Env. Faltando AUD ou domínio do time, ou domínio que não é um host: nulo. */
export function accessConfig(env: Env): AccessConfig | null {
  const aud = env.ACCESS_AUD?.trim() ?? "";
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/+$/, "");
  if (!aud || !HOST.test(teamDomain)) return null;
  return { aud, teamDomain };
}

/** O token do cabeçalho do Access; sem ele, o do cookie. */
export function accessToken(request: Request): string | null {
  const header = request.headers.get(TOKEN_HEADER)?.trim();
  if (header) return header;
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === TOKEN_COOKIE) {
      const value = part.slice(separator + 1).trim();
      if (value) return value;
    }
  }
  return null;
}

export async function fetchJwksOverNetwork(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

interface CachedKeys {
  fetchedAt: number;
  keys: Map<string, Promise<CryptoKey | null>>;
}

/**
 * Cria um verificador com cache próprio das chaves, por URL de certificados: renova depois do TTL
 * e busca de novo, uma vez, quando chega um kid que o cache não conhece.
 */
export function createAccessVerifier(
  fetchJwks: FetchJwks,
  options: { now?: () => number; ttlMs?: number } = {},
): AccessVerifier {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? JWKS_TTL_MS;
  const cache = new Map<string, CachedKeys>();

  async function load(url: string): Promise<CachedKeys> {
    let body: unknown;
    try {
      body = await fetchJwks(url);
    } catch {
      throw new Unavailable();
    }
    const entry: CachedKeys = { fetchedAt: now(), keys: parseJwks(body) };
    cache.set(url, entry);
    return entry;
  }

  async function keyFor(url: string, kid: string): Promise<CryptoKey | null> {
    let entry = cache.get(url);
    if (!entry || now() - entry.fetchedAt >= ttlMs) entry = await load(url);
    if (!entry.keys.has(kid) && now() - entry.fetchedAt >= JWKS_MIN_REFETCH_MS) entry = await load(url);
    return (await entry.keys.get(kid)) ?? null;
  }

  return {
    async verify(token, config) {
      const parsed = parseToken(token);
      if (!parsed) return { ok: false, reason: "invalid" };
      let key: CryptoKey | null;
      try {
        key = await keyFor(`https://${config.teamDomain}/cdn-cgi/access/certs`, parsed.kid);
      } catch (error) {
        if (error instanceof Unavailable) return { ok: false, reason: "unavailable" };
        throw error;
      }
      if (!key) return { ok: false, reason: "invalid" };
      const valid = await crypto.subtle.verify(RS256, key, parsed.signature, parsed.signedInput);
      if (!valid || !claimsAccepted(parsed.claims, config, now())) return { ok: false, reason: "invalid" };
      const email = parsed.claims.email;
      return { ok: true, identity: { email: typeof email === "string" ? email : null } };
    },
  };
}

/** Quem a requisição é, ou a resposta que a recusa. O chamador decide o que é protegido. */
export async function authenticate(
  request: Request,
  env: Env,
  verifier: AccessVerifier,
): Promise<{ identity: Identity } | { response: Response }> {
  // O token vem antes da configuração: sem token é 401 mesmo com o Access ainda sem variáveis.
  const token = accessToken(request);
  if (!token) return { response: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  const config = accessConfig(env);
  if (!config) return { response: Response.json({ error: "access_not_configured" }, { status: 503 }) };
  const result = await verifier.verify(token, config);
  if (result.ok) return { identity: result.identity };
  if (result.reason === "unavailable") {
    return { response: Response.json({ error: "access_unavailable" }, { status: 503 }) };
  }
  return { response: Response.json({ error: "forbidden" }, { status: 403 }) };
}

interface ParsedToken {
  kid: string;
  claims: Record<string, unknown>;
  signedInput: Uint8Array;
  signature: Uint8Array;
}

function parseToken(token: string): ParsedToken | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = decodeJson(encodedHeader);
  const claims = decodeJson(encodedPayload);
  const signature = decodeBase64Url(encodedSignature);
  if (!header || !claims || !signature) return null;
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return null;
  return {
    kid: header.kid,
    claims,
    signedInput: new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    signature,
  };
}

function claimsAccepted(claims: Record<string, unknown>, config: AccessConfig, nowMs: number): boolean {
  const nowS = Math.floor(nowMs / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.aud)) return false;
  if (claims.iss !== `https://${config.teamDomain}`) return false;
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S <= nowS) return false;
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - CLOCK_SKEW_S > nowS)) return false;
  return true;
}

/** As chaves RSA do JWKS, por kid. A importação é preguiçosa e fica guardada junto. */
function parseJwks(body: unknown): Map<string, Promise<CryptoKey | null>> {
  const keys = new Map<string, Promise<CryptoKey | null>>();
  const list = isRecord(body) && Array.isArray(body.keys) ? body.keys : [];
  for (const jwk of list) {
    if (!isRecord(jwk) || jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    const material: JsonWebKey = { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true };
    keys.set(
      jwk.kid,
      crypto.subtle.importKey("jwk", material, RS256, false, ["verify"]).catch(() => null),
    );
  }
  return keys;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(segment: string): Uint8Array | null {
  if (!B64URL.test(segment)) return null;
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
