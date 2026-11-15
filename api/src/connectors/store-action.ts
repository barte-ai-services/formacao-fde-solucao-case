// Caixa de saída para o app da loja: a ação no recebimento da nota de loja (outbox_store_actions) (#135).
import { isRecord, isString, type Guard } from './guards.js';
import { SupabaseOutbox } from './outbox.js';
import type { StoreActionMessage, StoreActionOutbox } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';
import { decodeAction, encodeAction, isEncodedAction, type EncodedAction } from './wms-dock-action.js';

type Encoded = EncodedAction & { store: string };

const isEncoded: Guard<Encoded> = (v): v is Encoded => isRecord(v) && isString(v.store) && isEncodedAction(v);

export function appStoreActionOutbox(rest: SupabaseRest): StoreActionOutbox {
  return new SupabaseOutbox<StoreActionMessage, Encoded>(rest, 'outbox_store_actions', {
    encode: (m) => ({ ...encodeAction(m.action), store: m.store }),
    isEncoded,
    decode: (invoiceAccessKey, p) => ({ invoiceAccessKey, store: p.store, action: decodeAction(p) }),
  });
}
