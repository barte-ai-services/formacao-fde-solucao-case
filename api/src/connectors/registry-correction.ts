// Caixa de saída para o ERP Cadastro: item sem cadastro (E8) e fator de caixa (E4) (outbox_registry_corrections) (#59, AC-4).
import { isString, nullable, oneOf, shaped, type Shape } from './guards.js';
import { SupabaseOutbox } from './outbox.js';
import type { RegistryCorrectionMessage, RegistryCorrectionOutbox } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

type Encoded = Omit<RegistryCorrectionMessage, 'invoiceAccessKey'>;

const isEncoded = shaped<Encoded>({
  kind: oneOf('E8_item_sem_cadastro', 'E4_fator_de_caixa'),
  supplierCode: isString,
  sku: nullable(isString),
  detail: isString,
} satisfies Shape<Encoded>);

export function registryCorrectionOutbox(rest: SupabaseRest): RegistryCorrectionOutbox {
  return new SupabaseOutbox(rest, 'outbox_registry_corrections', {
    encode: ({ kind, supplierCode, sku, detail }: RegistryCorrectionMessage): Encoded => ({ kind, supplierCode, sku, detail }),
    isEncoded,
    decode: (invoiceAccessKey: string, p: Encoded): RegistryCorrectionMessage => ({ invoiceAccessKey, ...p }),
  });
}
