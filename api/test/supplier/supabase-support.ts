import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import type { NewRequest } from '../../src/supplier/ports.js';
import { SOURCE_KEY, returnNote } from '../domain/supplier-request-fixtures.js';
import { GOOD_TEXT, SUPPLIER_EMAIL } from './doubles.js';

// #156: apoio dos testes dos adaptadores do Supabase: o banco falso com as restrições da migração e o REST em cima dele.

export const OPEN_STATUSES = ['draft', 'sent', 'send_failed'];

export type Harness = { fake: FakePostgrest; rest: SupabaseRest };

/** #156: o `fake` com as duas restrições únicas da migração (a parcial do pedido e a da nota por devolução). */
export const harness = (seed: Record<string, Record<string, unknown>[]> = {}): Harness => {
  const fake = new FakePostgrest(seed);
  fake.unique('outbox_supplier_emails', ['invoice_access_key', 'request_type'], (row) => OPEN_STATUSES.includes(String(row.status)));
  fake.unique('issued_return_notes', ['queue_id']);
  const rest = new SupabaseRest({ url: 'https://projeto.test', secretKey: 'sb_secret_teste', fetch: fake.fetch });
  return { fake, rest };
};

export const newRequest = (over: Partial<NewRequest> = {}): NewRequest => ({
  invoiceAccessKey: SOURCE_KEY,
  queueId: 7,
  note: returnNote(),
  to: SUPPLIER_EMAIL,
  draftedOn: '2026-11-12',
  model: 'claude-teste',
  by: 'agente',
  outcome: { kind: 'draft', text: GOOD_TEXT },
  ...over,
});

/** #156: a nota de origem como a tabela `invoices` a guarda (centavos, itens em jsonb). */
export const invoiceRow = (): Record<string, unknown> => ({
  access_key: SOURCE_KEY,
  number: '43894',
  series: '1',
  supplier_id: 'F02',
  store: 'LJ-012',
  issued_on: '2026-11-09',
  purchase_order_ref: 'OC-2026-42328',
  entry_channel: 'sefaz',
  total_cents: 208288,
  state: 'a_conferir',
  items: [
    { supplierCode: 'F02-002', sku: 'SKU-1006', description: 'Refrigerante cola 2 L', quantity: { amount: 72, unit: 'UN' }, unitPriceCents: 849, totalCents: 61128 },
    { supplierCode: 'F02-004', sku: 'SKU-1008', description: 'Água de coco 1 L', quantity: { amount: 28, unit: 'UN' }, unitPriceCents: 970, totalCents: 27160 },
    { supplierCode: 'F02-005', sku: null, description: 'Arroz 5 kg', quantity: { amount: 12, unit: 'CX' }, unitPriceCents: 10000, totalCents: 120000 },
  ],
});

export const supplierRow = (email: string | null = SUPPLIER_EMAIL): Record<string, unknown> => ({
  fornecedor_id: 'F02', // ADR-001
  razao_social: 'Bebidas Rio Claro S.A.', // ADR-001
  cnpj: '74.055.489/0001-48', // ADR-001
  bloqueado: false, // ADR-001
  motivo_bloqueio: '', // ADR-001
  email,
});

/** #156: a devolução pendente da fila (#140), com a linha que o pedido devolve. */
export const queueRow = (id = 7): Record<string, unknown> => ({
  id,
  invoice_access_key: SOURCE_KEY,
  payload: { lines: [{ supplierCode: 'F02-002', amount: 7, unit: 'UN' }], reason: 'item trocado' },
  published_at: '2026-11-12T10:00:00Z',
  status: 'pendente',
  nfe_number: null,
  emitted_by: null,
  emitted_at: null,
  cancel_justification: null,
  cancelled_by: null,
  cancelled_at: null,
});
