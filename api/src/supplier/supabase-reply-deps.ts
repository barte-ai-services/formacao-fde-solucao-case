import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { mockMailer } from './mock-mailer.js';
import type { Clock, SupplierMailer } from './ports.js';
import type { FollowUpMailer, ReplyDeps } from './reply-ports.js';
import { supabaseSupplierInbox } from './supabase-reply-inbox.js';
import { supabaseReplyRequestStore } from './supabase-reply-store.js';

// #157: as portas da leitura da resposta (#157) ligadas ao Supabase da #157 e ao envio da #156; mesma montagem de supabase-deps.ts.

export type ReplyDepsOptions = {
  readonly clock?: Clock;
  /** #157: o envio da #156 (`mailerFromEnv`); sem escolha, a caixa de saída mock. A cobrança sai pelo mesmo envio do pedido. */
  readonly mailer?: SupplierMailer;
};

/** #157: a cobrança usa o envio do pedido (#156); a chave de idempotência é uma por nota, para o provedor deduplicar. */
export const followUpMailer = (mailer: SupplierMailer): FollowUpMailer => ({
  send: (message) => mailer.send({ ...message, idempotencyKey: `follow-up:${message.invoiceAccessKey}` }),
});

export function replyDeps(rest: SupabaseRest, options: ReplyDepsOptions = {}): ReplyDeps {
  const clock = options.clock ?? { now: () => new Date() };
  return {
    inbox: supabaseSupplierInbox(rest, clock),
    requests: supabaseReplyRequestStore(rest, clock),
    mailer: followUpMailer(options.mailer ?? mockMailer()),
    clock,
  };
}
