import { AsyncLocalStorage } from "node:async_hooks";

/** O cabeçalho que o MCP e a API trocam para seguir uma falha de um log ao outro (#292). */
const HEADER = "X-Correlation-Id";

/** #293 Só estes caracteres, de 8 a 64: cabe um UUID e não cabe CR/LF, espaço nem markup. */
const FORMAT = /^[A-Za-z0-9_-]{8,64}$/;

/** O mínimo do console que o id usa; os testes injetam um, sem depender do global. */
export interface ConsoleLike {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const LEVELS = ["log", "info", "warn", "error"] as const;
/** #293 As funções que este módulo criou, para reconhecê-las ao instalar de novo. */
const wrappers = new WeakSet<object>();

/** #293 O id da requisição em andamento; vazio fora dela, como no Cron. */
const requestId = new AsyncLocalStorage<string>();

export function isValidCorrelationId(value: string | null | undefined): value is string {
  return typeof value === "string" && FORMAT.test(value);
}

/**
 * Troca o `log`, `info`, `warn` e `error` do console por versões que acrescentam `{ correlationId }` como
 * último argumento enquanto há uma requisição em andamento (o Workers Logs indexa o objeto). Fora dela
 * nada muda. Idempotente: instalar de novo no mesmo console não empilha o id.
 */
export function installCorrelationConsole(target: ConsoleLike): void {
  for (const level of LEVELS) {
    const original = target[level];
    if (wrappers.has(original)) continue;
    const wrapped = (...args: unknown[]): void => {
      const id = requestId.getStore();
      original.apply(target, id === undefined ? args : [...args, { correlationId: id }]);
    };
    wrappers.add(wrapped);
    target[level] = wrapped;
  }
}

/**
 * Lê o id do cabeçalho ou gera um, deixa-o em todas as linhas de log de `next` e o devolve no cabeçalho
 * da resposta. Um valor fora do formato é descartado sem ir para log nem para a resposta.
 */
export async function withCorrelationId(request: Request, next: () => Promise<Response>): Promise<Response> {
  const received = request.headers.get(HEADER);
  const id = isValidCorrelationId(received) ? received : crypto.randomUUID();
  try {
    return withHeader(await requestId.run(id, next), id);
  } catch (error) {
    // #293 Uma exceção fora da rota sai como 500 genérico, com o id; no log, só o nome do erro, nunca texto nem pilha.
    return requestId.run(id, () => failedResponse(error, id));
  }
}

/** #293 O 500 genérico, no formato do resto da API (`internal_error` e `correlationId`), com o id no cabeçalho. */
function failedResponse(error: unknown, id: string): Response {
  const errorName = error instanceof Error ? error.name : "unknown";
  console.error("#293 exceção fora da rota", { errorName });
  return withHeader(Response.json({ error: "internal_error", correlationId: id }, { status: 500 }), id);
}

/** #293 Os cabeçalhos de uma resposta de fetch (os assets) podem ser imutáveis: nesse caso, refaz a resposta. */
function withHeader(response: Response, id: string): Response {
  try {
    response.headers.set(HEADER, id);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(HEADER, id);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

// #293 Uma vez por isolate, no console global; as linhas do Cron ficam como estão.
installCorrelationConsole(console);
