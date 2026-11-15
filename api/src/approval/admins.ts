// #174 De quem passou pelo Access ao papel de administrador.

/**
 * A lista vem da variável `BARTE_ACADEMY_ADMIN_EMAILS` do Worker: um JSON de lista de e-mails. Não é
 * segredo; muda com `wrangler deploy --var`. Vazia, malformada ou sem o e-mail: não é administrador.
 * O e-mail é comparado sem diferença de maiúsculas, como o Access o entrega.
 */
export function isAdmin(raw: string | undefined, email: string | null): boolean {
  if (!raw || !email) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const wanted = email.trim().toLowerCase();
  return parsed.some((item) => typeof item === 'string' && item.trim().toLowerCase() === wanted);
}
