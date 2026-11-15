/**
 * O cliente da API do Worker. A tela e a API moram na mesma origem, atrás do mesmo Cloudflare
 * Access: o cookie `CF_Authorization` vai junto (`credentials: "same-origin"`) e nenhum token
 * passa pelo código da tela.
 *
 * Convenção: os endpoints de domínio que as histórias criarem vivem sob `/api/...`.
 */
import type { MeDto } from "./contract";

/** A API respondeu fora do 2xx, ou a rede falhou (`status` 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** O `error` do corpo JSON, quando o Worker mandou um (`unauthenticated`, `forbidden`, `not_found`…). */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** 401 ou 403: o Access não reconheceu a pessoa. A tela mostra o erro e oferece tentar de novo. */
  get isUnauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

async function errorFrom(response: Response): Promise<ApiError> {
  let code: string | null = null;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") code = body.error;
  } catch {
    // Corpo que não é JSON: fica só o status.
  }
  return new ApiError(response.status, code, `a API respondeu ${response.status}${code ? ` (${code})` : ""}`);
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(0, null, "não consegui falar com a API");
  }
  if (!response.ok) throw await errorFrom(response);
  if (response.status === 204) return undefined as T;
  // O tipo é o que o contrato promete; o Worker é quem garante a forma. Nenhuma validação aqui.
  return (await response.json()) as T;
}

export function apiGet<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
  return request<T>("GET", path, undefined, options.signal);
}

export function apiPost<T>(path: string, body: unknown, options: { signal?: AbortSignal } = {}): Promise<T> {
  return request<T>("POST", path, body, options.signal);
}

/** `GET /me`: quem passou pelo Cloudflare Access (#54). */
export function me(options: { signal?: AbortSignal } = {}): Promise<MeDto> {
  return apiGet<MeDto>("/me", options);
}
