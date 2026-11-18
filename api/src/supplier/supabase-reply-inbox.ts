import { isInteger, isString, oneOf, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import type { Clock, InboxMessage, SupplierInbox } from './reply-ports.js';
import { SUPPLIER_READING_TASK } from './reply-task.js';
import { guarded, refused } from './supabase-reply-call.js';

// #157: a caixa de entrada mock (inbox_supplier_messages), modo upsert-with-history/in-row-transition: a mensagem não muda e
// #157: read_status sai de `pending` uma vez, para `ok` ou `error`. Cada transição é UM `PATCH` filtrado por `read_status=eq.pending`.

const TABLE = 'inbox_supplier_messages';
/** #157: o motivo fechado `<motivo>: <campo>`; o banco recusa o resto pelo mesmo formato. */
const CLOSED_REASON = /^[a-z_]+: [a-z_]+$/;

type MessageRow = { id: number; request_id: number; body: string };
const isMessage = shaped<MessageRow>({ id: isInteger, request_id: isInteger, body: isString } satisfies Shape<MessageRow>);

type StateRow = { read_status: 'pending' | 'ok' | 'error'; read_error: string | null };
const isState = shaped<StateRow>({
  read_status: oneOf('pending', 'ok', 'error'), // ADR-002
  read_error: (v): v is string | null => v === null || typeof v === 'string',
} satisfies Shape<StateRow>);

const toMessage = (row: MessageRow): InboxMessage => ({ id: row.id, requestId: row.request_id, text: row.body });

export function supabaseSupplierInbox(rest: SupabaseRest, clock: Clock): SupplierInbox {
  const pending = (id?: number) =>
    guarded(async () =>
      parseRows(
        await rest.select(TABLE, {
          select: 'id,request_id,body',
          filters: { read_status: 'eq.pending', ...(id === undefined ? {} : { id: `eq.${id}` }) },
          order: 'id',
          ...(id === undefined ? {} : { limit: 1 }),
        }),
        isMessage,
        TABLE,
      ),
    );

  /** #157: a transição guardada; com 0 linhas relê, e só a mensagem já no mesmo estado final é idempotente. */
  async function transition(id: number, operation: string, to: 'ok' | 'error', reason: string | null): Promise<void> {
    const at = clock.now().toISOString();
    // #157 PER-3: quem fez a transição é a tarefa da leitura (não há ato humano aqui), gravada na própria linha com o quando.
    const by = SUPPLIER_READING_TASK;
    const body = to === 'ok' ? { read_status: 'ok', read_status_at: at, read_status_by: by } : { read_status: 'error', read_error: reason, read_status_at: at, read_status_by: by };
    const updated = await guarded(() => rest.update(TABLE, { id: `eq.${id}`, read_status: 'eq.pending' }, body));
    if (updated.length > 0) return;
    const [now] = await guarded(async () =>
      parseRows(await rest.select(TABLE, { select: 'read_status,read_error', filters: { id: `eq.${id}` }, limit: 1 }), isState, TABLE),
    );
    if (now?.read_status === to && now.read_error === reason) return;
    throw refused(operation, TABLE);
  }

  return {
    listPending: async () => (await pending()).map(toMessage),
    async get(id) {
      const [row] = await pending(id);
      return row === undefined ? null : toMessage(row);
    },
    markRead: (id) => transition(id, 'mark_read', 'ok', null),
    markError(id, reason) {
      // #157: só o motivo fechado vai ao banco; o texto do modelo ou do fornecedor nunca é gravado.
      if (!CLOSED_REASON.test(reason)) return Promise.reject(refused('mark_error', TABLE));
      return transition(id, 'mark_error', 'error', reason);
    },
  };
}
