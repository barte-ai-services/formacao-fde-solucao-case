import type { Identity } from "./access";

/** Devolve quem passou pelo Cloudflare Access. A rota protegida mínima, para testar ponta a ponta (#54). */
export function me(identity: Identity): Response {
  return Response.json({ email: identity.email });
}
