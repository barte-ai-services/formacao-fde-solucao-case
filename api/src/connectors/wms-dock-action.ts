// Caixa de saída para o WMS: a ação na doca aprovada (outbox_dock_actions) (#59, AC-4).
import { DockAction, Quantity, type PartialLine } from '../domain/index.js';
import { arrayOf, isNumber, isString, oneOf, optional, shaped, type Shape } from './guards.js';
import { SupabaseOutbox } from './outbox.js';
import type { DockActionMessage, DockActionOutbox } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

type EncodedLine = { sku: string; amount: number; unit: 'UN' | 'CX'; disposition: PartialLine['disposition'] };
export type EncodedAction = { kind: DockAction['kind']; lines?: EncodedLine[] };

const isEncodedLine = shaped<EncodedLine>({
  sku: isString,
  amount: isNumber,
  unit: oneOf('UN', 'CX'),
  disposition: oneOf('segurar', 'devolver'),
} satisfies Shape<EncodedLine>);

export const isEncodedAction = shaped<EncodedAction>({
  kind: oneOf('receber', 'receber_parcial', 'recusar'),
  lines: optional(arrayOf(isEncodedLine)),
} satisfies Shape<EncodedAction>);

export function encodeAction(action: DockAction): EncodedAction {
  if (action.kind !== 'receber_parcial') return { kind: action.kind };
  return {
    kind: action.kind,
    lines: action.lines.map((l) => ({
      sku: l.sku,
      amount: l.quantity.amount,
      unit: l.quantity.unit,
      disposition: l.disposition,
    })),
  };
}

export function decodeAction(p: EncodedAction): DockAction {
  return p.kind === 'receber'
      ? DockAction.receive()
      : p.kind === 'recusar'
        ? DockAction.refuse()
        : DockAction.partial(
            (p.lines ?? []).map((l) => ({
              sku: l.sku,
              quantity: Quantity.of(l.amount, l.unit),
              disposition: l.disposition,
            })),
          );
}

const encode = (message: DockActionMessage): EncodedAction => encodeAction(message.action);
const decode = (invoiceAccessKey: string, p: EncodedAction): DockActionMessage => ({ invoiceAccessKey, action: decodeAction(p) });

export function wmsDockActionOutbox(rest: SupabaseRest): DockActionOutbox {
  return new SupabaseOutbox(rest, 'outbox_dock_actions', { encode, isEncoded: isEncodedAction, decode });
}
