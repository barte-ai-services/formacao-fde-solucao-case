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
    /** #157 O `reason` do corpo de um 409, cru: quem o lê o reduz a um conjunto fechado (supplier-reply.ts) e o texto nunca vai à tela nem à mensagem (layer-exposure). */
    readonly reason: string | null = null,
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
  let reason: string | null = null;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") code = body.error;
    if (body && typeof body === "object" && "reason" in body && typeof body.reason === "string") reason = body.reason;
  } catch {
    // Corpo que não é JSON: fica só o status.
  }
  return new ApiError(response.status, code, `a API respondeu ${response.status}${code ? ` (${code})` : ""}`, reason);
}

/** #156 Quanto a tela espera uma chamada antes de dar por falha (REL-1, #37): a ação parada termina, não fica pendurada. */
export const DEFAULT_TIMEOUT_MS = 15_000;

interface CallOptions {
  signal?: AbortSignal;
  /** #156 O prazo desta chamada; sem ele vale DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

type Method = "GET" | "POST" | "PATCH";

async function request<T>(method: Method, path: string, body: unknown, options: CallOptions): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  // #156 O prazo é um sinal próprio, junto com o de quem chamou: o cancelamento do chamador segue sendo AbortError.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("prazo da chamada esgotado", "TimeoutError")), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // #156 O sinal do chamador, repassado à mão (AbortSignal.any não existe em todo ambiente em que a tela roda).
  const forward = (): void => deadline.abort(options.signal?.reason);
  if (options.signal?.aborted) forward();
  else options.signal?.addEventListener("abort", forward, { once: true });
  try {
    return await exchange<T>(method, path, { headers, body, signal: deadline.signal });
  } finally {
    // #156 O prazo cobre a resposta inteira, corpo incluído: só some quando a chamada acaba.
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forward);
  }
}

async function exchange<T>(method: Method, path: string, init: { headers: Record<string, string>; body: unknown; signal: AbortSignal }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: init.headers,
      credentials: "same-origin",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(0, null, "não consegui falar com a API");
  }
  if (!response.ok) throw await errorFrom(response);
  if (response.status === 204) return undefined as T;
  // O tipo é o que o contrato promete; o Worker é quem garante a forma. Nenhuma validação aqui.
  try {
    return (await response.json()) as T;
  } catch (cause) {
    // #156 O prazo que estoura com o corpo ainda a caminho é falha de rede, não cancelamento.
    if (cause instanceof DOMException && cause.name === "TimeoutError") throw new ApiError(0, null, "não consegui falar com a API");
    throw cause;
  }
}

export function apiGet<T>(path: string, options: CallOptions = {}): Promise<T> {
  return request<T>("GET", path, undefined, options);
}

export function apiPost<T>(path: string, body: unknown, options: CallOptions = {}): Promise<T> {
  return request<T>("POST", path, body, options);
}

/** #156 A edição parcial de um recurso (o texto do pedido ao fornecedor). */
export function apiPatch<T>(path: string, body: unknown, options: CallOptions = {}): Promise<T> {
  return request<T>("PATCH", path, body, options);
}

/** `GET /me`: quem passou pelo Cloudflare Access (#54). */
export function me(options: CallOptions = {}): Promise<MeDto> {
  return apiGet<MeDto>("/me", options);
}
