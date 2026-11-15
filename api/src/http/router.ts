import { health } from "./health";

type Handler = () => Response;

const routes: Record<string, Record<string, Handler>> = {
  "/health": { GET: health },
};

/** Encaminha a requisição pela rota e pelo método. Rota desconhecida: 404. Método não aceito: 405. */
export function route(request: Request): Response {
  const { pathname } = new URL(request.url);
  const methods = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
  if (!methods) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const handler = Object.hasOwn(methods, request.method) ? methods[request.method] : undefined;
  if (!handler) {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: Object.keys(methods).join(", ") } },
    );
  }
  return handler();
}
