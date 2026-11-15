import type { Check } from './check.js';

/**
 * E7 — pago fora do fluxo: pagamento no banco sem a nota passar pelo contas a pagar.
 * Regra que rege: regras 2 e 6.
 * Dona: plano #64 (história #33).
 *
 * Preencha aqui; não mude o nome nem a assinatura.
 */
export const checkPagoForaDoFluxo: Check = (_invoice, _ctx) => [];
