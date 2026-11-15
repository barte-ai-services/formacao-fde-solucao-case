// Caixa de saída para o WMS: a ação na doca aprovada (outbox_dock_actions) (#59, AC-4).
import { DockAction, Quantity, type PartialLine } from '../domain/index.js';
import { SupabaseOutbox } from './outbox.js';
import type { DockActionMessage, DockActionOutbox } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

type EncodedLine = { sku: string; amount: number; unit: 'UN' | 'CX'; disposition: PartialLine['disposition'] };
type EncodedAction = { kind: DockAction['kind']; lines?: EncodedLine[] };

function encode(message: DockActionMessage): EncodedAction {
  const { action } = message;
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

function decode(invoiceAccessKey: string, payload: unknown): DockActionMessage {
  const p = payload as EncodedAction;
  const action =
    p.kind === 'receber'
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
  return { invoiceAccessKey, action };
}

export function wmsDockActionOutbox(rest: SupabaseRest): DockActionOutbox {
  return new SupabaseOutbox<DockActionMessage>(rest, 'outbox_dock_actions', { encode, decode });
}
