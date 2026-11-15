// #63 De quem passou pelo Access ao nível na régua.
import { isPersonLevel, type PersonLevel } from '../domain/approval-policy.js';

/**
 * #63 O nível de cada pessoa vem da variável `APPROVER_LEVELS` do Worker: um JSON de e-mail para
 * nível (`{"ana@jachegou.com.br":"analista"}`). Não é segredo; muda com `wrangler deploy --var`.
 * E-mail fora da lista, ou com nível que não é de pessoa, não tem nível: vê a fila e não aprova.
 * O e-mail é comparado sem diferença de maiúsculas, como o Access o entrega.
 */
export type ApproverDirectory = (email: string | null) => PersonLevel | null;

export function approverDirectory(raw: string | undefined): ApproverDirectory {
  const levels = new Map<string, PersonLevel>();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [email, level] of Object.entries(parsed)) {
        if (isPersonLevel(level)) levels.set(email.trim().toLowerCase(), level);
      }
    }
  }
  return (email) => (email ? (levels.get(email.trim().toLowerCase()) ?? null) : null);
}
