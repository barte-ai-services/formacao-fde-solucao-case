// Caixa de saída para o ERP: a nota de devolução das linhas devolvidas (outbox_return_notes) (#59, AC-4).
import { Quantity } from '../domain/index.js';
import { arrayOf, isNumber, isString, oneOf, shaped, type Shape } from './guards.js';
import { SupabaseOutbox } from './outbox.js';
import type { ReturnNoteMessage, ReturnNoteOutbox } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

type EncodedLine = { supplierCode: string; amount: number; unit: 'UN' | 'CX' };
type Encoded = { lines: EncodedLine[]; reason: string };

const isEncodedLine = shaped<EncodedLine>({
  supplierCode: isString,
  amount: isNumber,
  unit: oneOf('UN', 'CX'),
} satisfies Shape<EncodedLine>);

const isEncoded = shaped<Encoded>({ lines: arrayOf(isEncodedLine), reason: isString } satisfies Shape<Encoded>);

export function erpReturnNoteOutbox(rest: SupabaseRest): ReturnNoteOutbox {
  return new SupabaseOutbox(rest, 'outbox_return_notes', {
    encode: ({ lines, reason }: ReturnNoteMessage): Encoded => ({
      lines: lines.map((l) => ({ supplierCode: l.supplierCode, amount: l.quantity.amount, unit: l.quantity.unit })),
      reason,
    }),
    isEncoded,
    decode: (invoiceAccessKey: string, p: Encoded): ReturnNoteMessage => ({
      invoiceAccessKey,
      reason: p.reason,
      lines: p.lines.map((l) => ({ supplierCode: l.supplierCode, quantity: Quantity.of(l.amount, l.unit) })),
    }),
  });
}
