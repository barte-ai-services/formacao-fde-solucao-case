import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { supabaseReturnNoteQueue } from '../returns/return-notes.js';
import { mockMailer } from './mock-mailer.js';
import type { Clock, SupplierDeps, SupplierMailer } from './ports.js';
import { supabaseIssuedNoteStore } from './supabase-notes.js';
import { supabaseSourceInvoices } from './supabase-source.js';
import { supabaseSupplierRequestStore } from './supabase-store.js';

// #156: as portas do pedido ao fornecedor (#156) ligadas ao Supabase; o envio é o mock enquanto ninguém passa outro `mailer`.

export type SupplierDepsOptions = {
  readonly clock?: Clock;
  /** #156: quem monta escolhe o envio (`mailerFromEnv`); sem escolha, a caixa de saída mock. */
  readonly mailer?: SupplierMailer;
};

export function supplierDeps(rest: SupabaseRest, options: SupplierDepsOptions = {}): SupplierDeps {
  const clock = options.clock ?? { now: () => new Date() };
  return {
    queue: supabaseReturnNoteQueue(rest),
    requests: supabaseSupplierRequestStore(rest, clock),
    notes: supabaseIssuedNoteStore(rest),
    source: supabaseSourceInvoices(rest),
    mailer: options.mailer ?? mockMailer(),
    clock,
  };
}
