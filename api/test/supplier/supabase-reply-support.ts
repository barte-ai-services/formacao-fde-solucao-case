import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import type { SupplierReading } from '../../src/domain/index.js';
import { noteToJson } from '../../src/supplier/supabase-notes.js';
import { SOURCE_KEY, returnNote } from '../domain/supplier-request-fixtures.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { ASKS, DUE, noReply, reading } from './reply-doubles.js';
import { SUPPLIER_EMAIL } from './doubles.js';
import { invoiceRow, supplierRow } from './supabase-support.js';

// #157: apoio dos testes dos adaptadores da leitura da resposta: o banco falso com as restrições da migração e as linhas de partida.

export const OUTBOX = 'outbox_supplier_emails';
export const INBOX = 'inbox_supplier_messages';
export const READINGS = 'supplier_reply_readings';

/** #157: as restrições únicas da migração desta camada: a caixa pela origem e o único no_reply por pedido (índice parcial). */
export const replyHarness = (seed: Record<string, Record<string, unknown>[]> = {}): { fake: FakePostgrest; rest: SupabaseRest } => {
  const fake = new FakePostgrest({ invoices: [invoiceRow()], kit_fornecedores: [supplierRow()], ...seed });
  fake.unique(INBOX, ['source_message_id']);
  fake.unique(READINGS, ['request_id'], (row) => row.message_id === null || row.message_id === undefined);
  const rest = new SupabaseRest({ url: 'https://projeto.test', secretKey: 'sb_secret_teste', fetch: fake.fetch });
  return { fake, rest };
};

/** #157: um pedido já enviado, como a migração da #156 o guarda, com a cobrança ainda vazia. */
export const sentRow = (id: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  invoice_access_key: SOURCE_KEY,
  queue_id: 7,
  supplier_id: 'F02',
  request_type: 'return_note',
  recipient: SUPPLIER_EMAIL,
  subject: 'Devolução da nota {{nota.numero}}',
  body: 'corpo',
  asks: [...ASKS],
  note: noteToJson(returnNote()),
  attachments: [],
  drafted_on: '2026-11-12',
  due_on: DUE,
  model: 'claude-teste',
  status: 'sent',
  discard_reason: null,
  send_failure_reason: null,
  issued_return_note_id: 1,
  channel: 'mock',
  provider_message_id: 'mock-0',
  sent_by: 'ana@jachegou.example',
  sent_at: '2026-11-12T12:00:00Z',
  discarded_by: null,
  discarded_at: null,
  version: 3,
  history: [
    { version: 1, at: '2026-11-12T10:00:00Z', by: 'agente', action: 'drafted', state: { status: 'draft' } },
    { version: 3, at: '2026-11-12T12:00:00Z', by: 'ana@jachegou.example', action: 'sent', state: { status: 'sent' } },
  ],
  send_claim: null,
  send_claimed_at: null,
  follow_up_draft: null,
  follow_up_rejection: null,
  follow_up_claimed_at: null,
  follow_up_claim: null,
  follow_up_sent_by: null,
  follow_up_sent_at: null,
  follow_up_channel: null,
  follow_up_provider_message_id: null,
  follow_up_failure: null,
  created_at: '2026-11-12T10:00:00Z',
  updated_at: '2026-11-12T12:00:00Z',
  ...over,
});

export const inboxRow = (id: number, requestId: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  request_id: requestId,
  source_message_id: `origem-${id}`,
  from_address: SUPPLIER_EMAIL,
  body: 'Emitimos a NF-D 881 para a devolução.',
  attachments_meta: [],
  received_at: '2026-11-13T09:00:00Z',
  read_status: 'pending',
  read_error: null,
  read_status_at: null,
  read_status_by: null,
  created_at: '2026-11-13T09:00:00Z',
  ...over,
});

/** #157: uma leitura já gravada, como a tabela a guarda (snake_case); `messageId` nulo é a da varredura. */
export const readingRow = (id: number, requestId: number, messageId: number | null, over: Partial<SupplierReading> = {}): Record<string, unknown> => {
  const r = messageId === null ? noReply() : reading({ summary: `Leitura da mensagem ${messageId}.`, ...over });
  return {
    id,
    request_id: requestId,
    message_id: messageId,
    reply_outcome: r.replyOutcome,
    fulfilled_asks: [...r.fulfilledAsks],
    supplier_document: r.supplierDocument,
    summary: r.summary,
    next_step: r.nextStep,
    injection_flag: r.injectionFlag,
    read_at: '2026-11-13T10:00:00Z',
  };
};
