// Caixa de saída para o ERP: a nota de devolução das linhas devolvidas (outbox_return_notes) (#59, AC-4).
import { Quantity } from '../domain/index.js';
import { SupabaseOutbox } from './outbox.js';
import type { ReturnNoteMessage, ReturnNoteOutbox } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

type Encoded = { lines: { supplierCode: string; amount: number; unit: 'UN' | 'CX' }[]; reason: string };

export function erpReturnNoteOutbox(rest: SupabaseRest): ReturnNoteOutbox {
  return new SupabaseOutbox<ReturnNoteMessage>(rest, 'outbox_return_notes', {
    encode: ({ lines, reason }): Encoded => ({
      lines: lines.map((l) => ({ supplierCode: l.supplierCode, amount: l.quantity.amount, unit: l.quantity.unit })),
      reason,
    }),
    decode: (invoiceAccessKey, payload) => {
      const p = payload as Encoded;
      return {
        invoiceAccessKey,
        reason: p.reason,
        lines: p.lines.map((l) => ({ supplierCode: l.supplierCode, quantity: Quantity.of(l.amount, l.unit) })),
      };
    },
  });
}
