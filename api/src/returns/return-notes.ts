// #140 A fila de notas de devolução: a caixa outbox_return_notes lida como fila de trabalho do fiscal.
import {
  arrayOf,
  isInteger,
  isNumber,
  isString,
  nullable,
  oneOf,
  parseRows,
  shaped,
  type Shape,
} from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';

export const RETURN_NOTE_STATUSES = ['pendente', 'emitida', 'cancelada'] as const; // ADR-002
export type ReturnNoteStatus = (typeof RETURN_NOTE_STATUSES)[number];

export type ReturnNoteLineView = {
  supplierCode: string;
  description: string;
  quantity: { amount: number; unit: 'UN' | 'CX' };
  /** #140 Centavos: quantidade devolvida vezes o preço da linha na nota; null se a nota não tem a linha. */
  valueCents: number | null;
};

export type ReturnNoteView = {
  id: number;
  status: ReturnNoteStatus;
  invoiceAccessKey: string;
  invoiceNumber: string | null;
  supplierId: string | null;
  reason: string;
  lines: ReturnNoteLineView[];
  valueCents: number | null;
  publishedAt: string;
  /** #140 Segundos desde que entrou na fila, até a emissão ou o cancelamento; null se a data não se lê. */
  pendingSeconds: number | null;
  emitted: { number: string; by: string; at: string } | null;
  cancelled: { justification: string; by: string; at: string } | null;
};

type PayloadLine = { supplierCode: string; amount: number; unit: 'UN' | 'CX' };
type Row = {
  id: number;
  invoice_access_key: string;
  payload: { lines: PayloadLine[]; reason: string };
  published_at: string;
  status: ReturnNoteStatus;
  nfe_number: string | null;
  emitted_by: string | null;
  emitted_at: string | null;
  cancel_justification: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
};

const isPayloadLine = shaped<PayloadLine>({
  supplierCode: isString,
  amount: isNumber,
  unit: oneOf('UN', 'CX'),
} satisfies Shape<PayloadLine>);

const isRow = shaped<Row>({
  id: isInteger,
  invoice_access_key: isString,
  payload: shaped<Row['payload']>({ lines: arrayOf(isPayloadLine), reason: isString }),
  published_at: isString,
  status: oneOf(...RETURN_NOTE_STATUSES),
  nfe_number: nullable(isString),
  emitted_by: nullable(isString),
  emitted_at: nullable(isString),
  cancel_justification: nullable(isString),
  cancelled_by: nullable(isString),
  cancelled_at: nullable(isString),
} satisfies Shape<Row>);

type InvoiceItem = { supplierCode: string; description: string; unitPriceCents: number };
type InvoiceRow = { access_key: string; number: string; supplier_id: string; items: InvoiceItem[] };

const isInvoiceRow = shaped<InvoiceRow>({
  access_key: isString,
  number: isString,
  supplier_id: isString,
  items: arrayOf(
    shaped<InvoiceItem>({ supplierCode: isString, description: isString, unitPriceCents: isNumber } satisfies Shape<InvoiceItem>),
  ),
} satisfies Shape<InvoiceRow>);

const TABLE = 'outbox_return_notes';
const COLUMNS =
  'id,invoice_access_key,payload,published_at,status,nfe_number,emitted_by,emitted_at,cancel_justification,cancelled_by,cancelled_at';

function toView(row: Row, invoice: InvoiceRow | undefined, now: Date): ReturnNoteView {
  const lines = row.payload.lines.map((l): ReturnNoteLineView => {
    const item = invoice?.items.find((i) => i.supplierCode === l.supplierCode);
    return {
      supplierCode: l.supplierCode,
      description: item?.description ?? l.supplierCode,
      quantity: { amount: l.amount, unit: l.unit },
      valueCents: item ? Math.round(item.unitPriceCents * l.amount) : null,
    };
  });
  const values = lines.map((l) => l.valueCents);
  const valueCents = values.every((v): v is number => v !== null) ? values.reduce((a, b) => a + b, 0) : null;
  const since = Date.parse(row.published_at);
  const end = Date.parse(row.emitted_at ?? row.cancelled_at ?? '') || now.getTime();
  return {
    id: row.id,
    status: row.status,
    invoiceAccessKey: row.invoice_access_key,
    invoiceNumber: invoice?.number ?? null,
    supplierId: invoice?.supplier_id ?? null,
    reason: row.payload.reason,
    lines,
    valueCents,
    publishedAt: row.published_at,
    pendingSeconds: Number.isNaN(since) ? null : Math.max(0, Math.round((end - since) / 1000)),
    emitted: row.status === 'emitida' && row.nfe_number && row.emitted_by && row.emitted_at
      ? { number: row.nfe_number, by: row.emitted_by, at: row.emitted_at }
      : null,
    cancelled: row.status === 'cancelada' && row.cancel_justification && row.cancelled_by && row.cancelled_at
      ? { justification: row.cancel_justification, by: row.cancelled_by, at: row.cancelled_at }
      : null,
  };
}

export type TransitionResult = { kind: 'ok'; note: ReturnNoteView } | { kind: 'not_found' } | { kind: 'conflict' };

export interface ReturnNoteQueue {
  list(status: ReturnNoteStatus, now: Date): Promise<ReturnNoteView[]>;
  emit(id: number, nfeNumber: string, by: string, now: Date): Promise<TransitionResult>;
  cancel(id: number, justification: string, by: string, now: Date): Promise<TransitionResult>;
}

export function supabaseReturnNoteQueue(rest: SupabaseRest): ReturnNoteQueue {
  async function withInvoices(rows: Row[], now: Date): Promise<ReturnNoteView[]> {
    const keys = [...new Set(rows.map((r) => r.invoice_access_key))];
    const invoices =
      keys.length === 0
        ? []
        : parseRows(
            await rest.select('invoices', {
              select: 'access_key,number,supplier_id,items',
              filters: { access_key: `in.(${keys.map((k) => `"${k}"`).join(',')})` },
            }),
            isInvoiceRow,
            'invoices',
          );
    return rows.map((row) => toView(row, invoices.find((i) => i.access_key === row.invoice_access_key), now));
  }

  /** #140 O PATCH só pega a linha ainda pendente: duas pessoas na mesma nota, só uma vence. */
  async function transition(id: number, patch: Record<string, unknown>, now: Date): Promise<TransitionResult> {
    const changed = parseRows(await rest.update(TABLE, { id: `eq.${id}`, status: 'eq.pendente' }, patch), isRow, TABLE); // ADR-002
    const [row] = changed;
    if (row) return { kind: 'ok', note: (await withInvoices([row], now))[0]! };
    const exists = await rest.select(TABLE, { select: 'id', filters: { id: `eq.${id}` } });
    return { kind: exists.length > 0 ? 'conflict' : 'not_found' };
  }

  return {
    async list(status, now) {
      const rows = parseRows(
        await rest.select(TABLE, { select: COLUMNS, filters: { status: `eq.${status}` }, order: 'id' }),
        isRow,
        TABLE,
      );
      return withInvoices(rows, now);
    },
    emit: (id, nfeNumber, by, now) =>
      transition(id, { status: 'emitida', nfe_number: nfeNumber, emitted_by: by, emitted_at: now.toISOString() }, now),
    cancel: (id, justification, by, now) =>
      transition(
        id,
        { status: 'cancelada', cancel_justification: justification, cancelled_by: by, cancelled_at: now.toISOString() },
        now,
      ),
  };
}
