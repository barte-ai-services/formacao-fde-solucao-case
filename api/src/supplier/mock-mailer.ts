import type { SupplierMailer } from './ports.js';

// #156: o envio do pedido pela caixa de saída mock, quando não há chave do Resend (#156).
// #156: o mock não grava nada: o registro do envio mock é a própria linha do pedido (canal `mock`,
// #156: identificador gerado), gravada pelo adaptador do pedido; uma raiz, um escritor.

/** #156: a chave do Resend é um secret do Worker; só se olha se está em branco, o valor nunca é lido nem registrado. */
export type MailerEnv = { readonly RESEND_API_KEY?: string };

/** #156: a caixa de saída mock: responde ok pelo canal `mock`, com o identificador derivado da chave da trava. */
export const mockMailer = (): SupplierMailer => ({
  send: async (message) => ({ ok: true, channel: 'mock', providerMessageId: `mock-${message.idempotencyKey}` }),
});

/** #156: com a chave presente e sem adaptador do Resend (fora desta camada), o envio falha fechado, sem cair no mock sem avisar. */
const resendUnavailable: SupplierMailer = { send: async () => ({ ok: false, reason: 'resend_unavailable' }) };

/** #156: sem a chave do Resend, o mock; com ela, o adaptador do Resend que quem monta passar. */
export function mailerFromEnv(env: MailerEnv, resend?: SupplierMailer): SupplierMailer {
  if ((env.RESEND_API_KEY ?? '').trim() === '') return mockMailer();
  return resend ?? resendUnavailable;
}
