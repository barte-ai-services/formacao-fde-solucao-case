// Caixa de saída para o ERP Cadastro: item sem cadastro (E8) e fator de caixa (E4) (outbox_registry_corrections) (#59, AC-4).
import { SupabaseOutbox } from './outbox.js';
import type { RegistryCorrectionMessage, RegistryCorrectionOutbox } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

type Encoded = Omit<RegistryCorrectionMessage, 'invoiceAccessKey'>;

export function registryCorrectionOutbox(rest: SupabaseRest): RegistryCorrectionOutbox {
  return new SupabaseOutbox<RegistryCorrectionMessage>(rest, 'outbox_registry_corrections', {
    encode: ({ kind, supplierCode, sku, detail }): Encoded => ({ kind, supplierCode, sku, detail }),
    decode: (invoiceAccessKey, payload) => {
      const p = payload as Encoded;
      return { invoiceAccessKey, kind: p.kind, supplierCode: p.supplierCode, sku: p.sku, detail: p.detail };
    },
  });
}
