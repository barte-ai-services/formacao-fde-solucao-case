/** Responde que o Worker está de pé. Não toca em nenhuma dependência. */
export function health(): Response {
  return Response.json({ status: "ok" });
}
