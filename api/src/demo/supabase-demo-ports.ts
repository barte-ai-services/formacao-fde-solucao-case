// #363 Os adaptadores das portas da contagem da doca e das respostas do fornecedor sobre o SupabaseRest. O custo é o declarado em
// #363 STEP_COSTS (cron/round-steps.ts): cada porta é UMA requisição (a leitura é uma rpc só, a gravação é um lote só).
// #363 Só notas origin = 'demo' são lidas (a rpc filtra no banco) e toda linha gravada leva origin = 'demo'.
import { isInteger, isNumber, isRecord, isString, nullable, oneOf, parseOne } from '../connectors/guards.js';
import type { Row, SupabaseRest } from '../connectors/supabase-rest.js';
import { SupabaseRestError } from '../connectors/supabase-rest.js';
import type { ExceptionCode } from '../domain/classification.js';
import type { DockCountSink, DockCountSource, PendingDockAction, PendingDockItem } from './dock-count.js';
import type { SentRequest, SupplierReplySink, SupplierReplySource } from './supplier-replies.js';

const FN_DOCK_PENDING = 'demo_dock_count_pending';
const FN_DOCK_INSERT = 'demo_insert_dock_counts';
const FN_REPLIES_PENDING = 'demo_supplier_replies_pending';
const INBOX = 'inbox_supplier_messages';

const isDate = (v: unknown): v is string => isString(v) && !Number.isNaN(new Date(v).getTime());
const EXCEPTIONS = new Set(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']);
const isException = (v: unknown): v is ExceptionCode => isString(v) && EXCEPTIONS.has(v);

type RawItem = { supplierCode: string; description: string; quantity: number; unit: string };
const isItem = (v: unknown): v is RawItem =>
  isRecord(v) && isString(v.supplierCode) && isString(v.description) && isNumber(v.quantity) && isString(v.unit);

type RawAction = {
  actionId: string; channel: 'dock' | 'store'; invoiceAccessKey: string; publishedAt: string; supplierId: string; store: string;
  purchaseOrderId: string | null; classification: ExceptionCode | null; items: RawItem[];
};
const isAction = (v: unknown): v is RawAction =>
  isRecord(v) && isString(v.actionId) && oneOf('dock', 'store')(v.channel) && isString(v.invoiceAccessKey) && isDate(v.publishedAt)
  && isString(v.supplierId) && isString(v.store) && nullable(isString)(v.purchaseOrderId) && nullable(isException)(v.classification)
  && Array.isArray(v.items) && v.items.every(isItem);

type RawRequest = { requestId: number; recipient: string; sentAt: string };
const isRequest = (v: unknown): v is RawRequest => isRecord(v) && isInteger(v.requestId) && isString(v.recipient) && isDate(v.sentAt);

function rowsOf<T>(payload: unknown, guard: (v: unknown) => v is T, table: string): T[] {
  if (!Array.isArray(payload)) throw new SupabaseRestError('parse', table, 0, 'resposta fora do formato esperado');
  return payload.map((row, index) => parseOne(row, guard, table, index));
}

/** #363 A contagem da doca: uma rpc de leitura (a ação, a exceção e os itens da nota juntos) e uma rpc de gravação em lote. */
export function supabaseDockCountPorts(rest: SupabaseRest): { source: DockCountSource; sink: DockCountSink } {
  return {
    source: {
      listPending: async (): Promise<readonly PendingDockAction[]> =>
        rowsOf(await rest.rpc(FN_DOCK_PENDING, {}), isAction, FN_DOCK_PENDING).map((a) => ({
          ...a,
          publishedAt: new Date(a.publishedAt),
          items: a.items.map((i): PendingDockItem => ({ supplierCode: i.supplierCode, description: i.description, quantity: i.quantity, unit: i.unit })),
        })),
    },
    sink: {
      writeBatch: async (batch) => {
        await rest.rpc(FN_DOCK_INSERT, { p_batch: { kit_recebimentos: batch.receipts, kit_recebimento_itens: batch.items } });
      },
    },
  };
}

/** #363 As respostas do fornecedor: uma rpc de leitura dos pedidos enviados sem resposta e um insert em lote na caixa de entrada mock. */
export function supabaseSupplierReplyPorts(rest: SupabaseRest): { source: SupplierReplySource; sink: SupplierReplySink } {
  return {
    source: {
      listPending: async (): Promise<readonly SentRequest[]> =>
        rowsOf(await rest.rpc(FN_REPLIES_PENDING, {}), isRequest, FN_REPLIES_PENDING).map((r) => ({
          requestId: r.requestId, recipient: r.recipient, sentAt: new Date(r.sentAt),
        })),
    },
    sink: {
      // #363 source_message_id é único: repetir o lote não duplica a resposta.
      writeBatch: async (rows) => {
        await rest.insert(INBOX, rows.map((r): Row => ({ ...r, origin: 'demo' })), { onConflict: 'source_message_id' });
      },
    },
  };
}
