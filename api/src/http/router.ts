import type { Env } from "../env";
import { authenticate, type AccessVerifier, type Identity } from "./access";
import { health } from "./health";
import { me } from "./me";
import { valorBarrado } from "./valor-barrado";

type PublicHandler = () => Response;
type ProtectedHandler = (identity: Identity, request: Request, env: Env) => Response | Promise<Response>;

/** Rotas abertas: não passam pelo Access. Só o `/health`, que a esteira e o monitor chamam (#54). */
const publicRoutes: Record<string, Record<string, PublicHandler>> = {
  "/health": { GET: health },
};

/** Rotas que exigem um JWT válido do Cloudflare Access (#54). */
const protectedRoutes: Record<string, Record<string, ProtectedHandler>> = {
  "/me": { GET: me },
  "/api/valor-barrado": { GET: valorBarrado },
};

export interface RouterDeps {
  verifier: AccessVerifier;
}

/**
 * Encaminha a requisição pela rota e pelo método. Fora das rotas abertas, o Access vem antes de
 * procurar a rota, então um caminho desconhecido sem token recebe 401, não 404 (#54).
 * Rota desconhecida: a tela (#60), se for um GET ou HEAD fora de `/api/` e os arquivos dela
 * existirem; senão 404. Método não aceito: 405.
 */
export async function route(request: Request, env: Env, deps: RouterDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  const open = own(publicRoutes, pathname);
  if (open) return dispatch(request, open, (handler) => handler());

  const auth = await authenticate(request, env, deps.verifier);
  if ("response" in auth) return auth.response;

  const methods = own(protectedRoutes, pathname);
  if (methods) return dispatch(request, methods, (handler) => handler(auth.identity, request, env));
  if (env.ASSETS && isScreenRequest(request.method, pathname)) return env.ASSETS.fetch(request);
  return Response.json({ error: "not_found" }, { status: 404 });
}

/** Um pedido da tela: só leitura, e nunca sob `/api/`, que é da API mesmo quando a rota não existe. */
function isScreenRequest(method: string, pathname: string): boolean {
  const reading = method === "GET" || method === "HEAD";
  const api = pathname === "/api" || pathname.startsWith("/api/");
  return reading && !api;
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function dispatch<H>(
  request: Request,
  methods: Record<string, H>,
  run: (handler: H) => Response | Promise<Response>,
): Response | Promise<Response> {
  const handler = own(methods, request.method);
  if (!handler) {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: Object.keys(methods).join(", ") } },
    );
  }
  return run(handler);
}
