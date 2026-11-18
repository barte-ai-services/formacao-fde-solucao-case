import {
  arrayOf,
  isInteger,
  isIsoDate,
  isString,
  isUnknown,
  nullable,
  oneOf,
  parseRows,
  shaped,
  type Shape,
} from '../connectors/guards.js';
import { SupabaseRestError, type Filters, type SupabaseRest } from '../connectors/supabase-rest.js';
import { DomainError, SupplierRequest, type RequestStatus, type RequestTextRejection, type SupplierRequestText } from '../domain/index.js';
import type { Clock, CreateResult, NewRequest, RequestChange, RequestRecord, SaveResult, SupplierRequestStore } from './ports.js';
import { noteFromJson, noteToJson, readIssuedNote } from './supabase-notes.js';

// #12: o pedido ao fornecedor (outbox_supplier_emails), modo upsert-with-history (supabase/persistence-modes.yaml).
// #12: cada gravação é UM `PATCH` filtrado pela versão lida: 0 linhas é `stale`. O PostgREST faz de cada requisição uma
// #12: transação de uma tabela, então estado, histórico e versão cabem numa linha só (coluna `history`, jsonb).
// #12: o envio toma uma trava com prazo antes de qualquer efeito. Resíduo aceito para o mock: se o processo morrer depois
// #12: de o e-mail sair e antes de gravar `sent`, o reenvio depois do prazo manda um segundo e-mail; a chave de idempotência
// #12: no provedor (o `send_claim`) é da camada do e-mail.

const TABLE = 'outbox_supplier_emails';
const REQUEST_TYPE = 'return_note'; // ADR-002
const OPEN = 'in.(draft,sent,send_failed)'; // ADR-002
const SENDABLE = 'in.(draft,send_failed)'; // ADR-002

/** #12: prazo da trava do envio: 5 minutos (assumido; o tempo máximo do envio de e-mail não foi informado). */
export const LEASE_MS = 5 * 60_000;

/** #12: falha do banco só com campos nomeados (a operação, a tabela, o status e o código do Postgres); nunca o texto nem o corpo da resposta. */
export class SupplierStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly table: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`supplier-store: ${operation} em ${table} falhou (HTTP ${status}${code === null ? '' : `, código ${code}`})`);
    this.name = 'SupplierStoreError';
  }
}

type Row = {
  id: number;
  invoice_access_key: string;
  queue_id: number;
  recipient: string;
  subject: string;
  body: string;
  asks: string[];
  note: unknown;
  drafted_on: string;
  due_on: string;
  status: RequestStatus;
  discard_reason: string | null;
  send_failure_reason: string | null;
  issued_return_note_id: number | null;
  version: number;
  history: unknown[];
  send_claim: string | null;
  sent_by: string | null;
  sent_at: string | null;
  discarded_by: string | null;
  discarded_at: string | null;
};

const isRow = shaped<Row>({
  id: isInteger,
  invoice_access_key: isString,
  queue_id: isInteger,
  recipient: isString,
  subject: isString,
  body: isString,
  asks: arrayOf(isString),
  note: isUnknown,
  drafted_on: isIsoDate,
  due_on: isIsoDate,
  status: oneOf('draft', 'sent', 'send_failed', 'discarded'), // ADR-002
  discard_reason: nullable(isString),
  send_failure_reason: nullable(isString),
  issued_return_note_id: nullable(isInteger),
  version: isInteger,
  history: arrayOf(isUnknown),
  send_claim: nullable(isString),
  sent_by: nullable(isString),
  sent_at: nullable(isString),
  discarded_by: nullable(isString),
  discarded_at: nullable(isString),
} satisfies Shape<Row>);

const isKeyRow = shaped<{ invoice_access_key: string }>({ invoice_access_key: isString });

/** #12: o estado inteiro depois de cada gravação, como entra no histórico. */
type State = {
  status: RequestStatus;
  body: string;
  discard_reason: string | null;
  send_failure_reason: string | null;
  issued_return_note_id: number | null;
};

/** #12: o que o adaptador guarda de cada pedido lido: a versão, o histórico e o estado. A trava não fica aqui: quem a tomou a leva. */
type Meta = { version: number; history: unknown[]; state: State };

const stateOf = (request: SupplierRequest): State => ({
  status: request.status,
  body: request.body,
  discard_reason: request.discardReason,
  send_failure_reason: request.sendFailureReason,
  issued_return_note_id: request.issuedNote?.number ?? null,
});

const corrupt = (detail: string): never => {
  throw new SupabaseRestError('parse', TABLE, 0, detail);
};

const REJECTION = /^(number_mismatch|invalid_shape): (subject|body|asks)$/;
const isWhy = oneOf<RequestTextRejection['reason']>('number_mismatch', 'invalid_shape');
const isField = oneOf<RequestTextRejection['field']>('subject', 'body', 'asks');

function rejectionOf(reason: string | null): RequestTextRejection {
  const [, why, field] = REJECTION.exec(reason ?? '') ?? [];
  if (!isWhy(why) || !isField(field)) return corrupt('motivo da recusa fora do formato');
  return { ok: false, reason: why, field };
}

/** #12: o código do Postgres que o PostgREST põe no corpo do erro; o resto do corpo não passa daqui. */
const pgCode = (detail: string): string | null => /"code"\s*:\s*"(\w{5})"/.exec(detail)?.[1] ?? null;

/** #12: a raiz é refeita pelos métodos dela, na ordem dos fatos (supabase/persistence-supplier-request.md). */
function rebuild(row: Row, issued: SupplierRequest['issuedNote']): SupplierRequest {
  const base = { id: row.id, invoiceAccessKey: row.invoice_access_key, note: noteFromJson(row.note, TABLE), draftedOn: row.drafted_on };
  const rejected = row.status === 'discarded' && row.subject === '';
  const text: SupplierRequestText = { subject: row.subject, body: row.body, asks: row.asks };
  const request = rejected
    ? SupplierRequest.rejected({ ...base, rejection: rejectionOf(row.discard_reason) })
    : SupplierRequest.draft({ ...base, text });
  if (issued !== null) request.recordIssuance(issued);
  if (row.send_failure_reason !== null) request.markSendFailed(row.send_failure_reason);
  if (row.status === 'sent') request.markSent();
  if (row.status === 'discarded' && !rejected) request.discard(row.discard_reason ?? '');
  if (request.status !== row.status || request.dueOn !== row.due_on) return corrupt('pedido fora do estado que a linha diz');
  return request;
}

export function supabaseSupplierRequestStore(rest: SupabaseRest, clock: Clock = { now: () => new Date() }): SupplierRequestStore {
  const metas = new Map<number, Meta>();

  async function toRecord(row: Row): Promise<RequestRecord> {
    const issued = row.issued_return_note_id === null ? null : await readIssuedNote(rest, { id: row.issued_return_note_id });
    if (row.issued_return_note_id !== null && issued === null) corrupt('a nota emitida do pedido não foi achada');
    let request: SupplierRequest;
    try {
      request = rebuild(row, issued);
    } catch (error) {
      if (error instanceof DomainError) return corrupt('pedido fora do que o domínio aceita');
      throw error;
    }
    metas.set(row.id, { version: row.version, history: row.history, state: stateOf(request) });
    const audit = { sentBy: row.sent_by, sentAt: row.sent_at, discardedBy: row.discarded_by, discardedAt: row.discarded_at };
    return { request, queueId: row.queue_id, to: row.recipient, audit };
  }

  const entry = (version: number, change: { by: string; at: Date; action: string }, state: State) => ({
    version,
    at: change.at.toISOString(),
    by: change.by,
    action: change.action,
    state,
  });

  /** #12: a versão lida e, enquanto a trava é de outro ou venceu, só grava quem a trava deixa; o dono grava pela chave dela. */
  async function patch(id: number, meta: Meta, filters: Filters, body: Record<string, unknown>): Promise<boolean> {
    const rows = await rest.update(TABLE, { id: `eq.${id}`, version: `eq.${meta.version}`, ...filters }, body);
    return rows.length > 0;
  }

  const expiredBefore = (at: Date): string => new Date(at.getTime() - LEASE_MS).toISOString();
  const notHeld = (at: Date): string => `(send_claim.is.null,send_claimed_at.lt.${expiredBefore(at)})`;

  return {
    async findOpen(invoiceAccessKey, requestType) {
      const rows = parseRows(
        await rest.select(TABLE, { filters: { invoice_access_key: `eq.${invoiceAccessKey}`, request_type: `eq.${requestType}`, status: OPEN }, limit: 1 }),
        isRow,
        TABLE,
      );
      return rows[0] === undefined ? null : toRecord(rows[0]);
    },

    async listOpenKeys(requestType, invoiceAccessKeys) {
      // #12/AC-6: sem nota perguntada não há o que ler; com notas, a leitura se limita a elas e o payload não cresce com o histórico.
      if (invoiceAccessKeys.length === 0) return new Set();
      const keys = invoiceAccessKeys.map((key) => `"${key}"`).join(',');
      const rows = parseRows(
        await rest.select(TABLE, {
          select: 'invoice_access_key',
          filters: { invoice_access_key: `in.(${keys})`, request_type: `eq.${requestType}`, status: OPEN },
        }),
        isKeyRow,
        TABLE,
      );
      return new Set(rows.map((row) => row.invoice_access_key));
    },

    async findLatest(invoiceAccessKey, requestType) {
      // #13: o mais novo pela identidade (a sequência cresce a cada pedido da nota); uma só linha.
      const rows = parseRows(
        await rest.select(TABLE, { filters: { invoice_access_key: `eq.${invoiceAccessKey}`, request_type: `eq.${requestType}` }, order: 'id.desc', limit: 1 }),
        isRow,
        TABLE,
      );
      return rows[0] === undefined ? null : toRecord(rows[0]);
    },

    async listByStatus(status, limit) {
      const rows = parseRows(await rest.select(TABLE, { filters: { status: `eq.${status}` }, order: 'id.desc', limit }), isRow, TABLE);
      return Promise.all(rows.map(toRecord));
    },

    async get(id) {
      const rows = parseRows(await rest.select(TABLE, { filters: { id: `eq.${id}` }, limit: 1 }), isRow, TABLE);
      return rows[0] === undefined ? null : toRecord(rows[0]);
    },

    async create(input: NewRequest): Promise<CreateResult> {
      const props = { id: 0, invoiceAccessKey: input.invoiceAccessKey, note: input.note, draftedOn: input.draftedOn };
      const provisional =
        input.outcome.kind === 'draft'
          ? SupplierRequest.draft({ ...props, text: input.outcome.text })
          : SupplierRequest.rejected({ ...props, rejection: input.outcome.rejection });
      const state = stateOf(provisional);
      const action = input.outcome.kind === 'draft' ? 'drafted' : 'rejected';
      let inserted: unknown[];
      try {
        inserted = await rest.insert(
          TABLE,
          [
            {
              invoice_access_key: input.invoiceAccessKey,
              queue_id: input.queueId,
              supplier_id: input.note.supplierId,
              request_type: REQUEST_TYPE,
              recipient: input.to,
              subject: provisional.subject,
              body: provisional.body,
              asks: [...provisional.asks],
              note: noteToJson(input.note),
              attachments: [],
              drafted_on: input.draftedOn,
              due_on: provisional.dueOn,
              model: input.model,
              status: provisional.status,
              discard_reason: provisional.discardReason,
              version: 1,
              history: [entry(1, { by: input.by, at: clock.now(), action }, state)],
            },
          ],
          { ignoreDuplicates: false },
        );
      } catch (error) {
        if (!(error instanceof SupabaseRestError) || error.operation !== 'insert') throw error;
        const code = pgCode(error.detail);
        // #12/AC-3: o índice único parcial recusou: já há pedido aberto desta nota e tipo. Outro 409 (a chave estrangeira) sobe.
        if (error.status === 409 && code === '23505') return { kind: 'conflict' };
        throw new SupplierStoreError('create', TABLE, error.status, code);
      }
      const [row] = parseRows(inserted, isRow, TABLE);
      if (row === undefined) return corrupt('o insert não devolveu a linha');
      return { kind: 'ok', record: await toRecord(row) };
    },

    async save(request, change: RequestChange): Promise<SaveResult> {
      const meta = metas.get(request.id);
      if (meta === undefined) return corrupt('pedido gravado sem ter sido lido');
      const version = meta.version + 1;
      const state = stateOf(request);
      const history = [...meta.history, entry(version, change, state)];
      const releases = change.action === 'sent' || change.action === 'send_failed';
      const claim = change.claim ?? null;
      const body: Record<string, unknown> = {
        status: state.status,
        body: state.body,
        discard_reason: state.discard_reason,
        send_failure_reason: state.send_failure_reason,
        issued_return_note_id: state.issued_return_note_id,
        version,
        history,
        updated_at: change.at.toISOString(),
      };
      if (change.sent !== undefined) {
        body.channel = change.sent.channel;
        body.provider_message_id = change.sent.providerMessageId;
        body.sent_by = change.by;
        body.sent_at = change.at.toISOString();
        body.attachments = change.sent.attachments.map((a) => ({
          filename: a.filename,
          content_type: a.contentType,
          issued_return_note_id: a.issuedReturnNoteId,
        }));
      }
      if (change.action === 'discarded') {
        body.discarded_by = change.by;
        body.discarded_at = change.at.toISOString();
      }
      // #12: quem leva a chave grava por ela e a limpa no último save; quem não leva só grava com a trava livre ou vencida.
      const filters: Filters = claim !== null ? { send_claim: `eq.${claim}` } : { or: notHeld(change.at) };
      if (claim === null || releases) {
        body.send_claim = null;
        body.send_claimed_at = null;
      }
      if (!(await patch(request.id, meta, filters, body))) return 'stale';
      metas.set(request.id, { version, history, state });
      return 'ok';
    },

    async claimSend(id, by, at) {
      const meta = metas.get(id);
      if (meta === undefined) return { kind: 'conflict' };
      const claim = crypto.randomUUID();
      const version = meta.version + 1;
      const history = [...meta.history, entry(version, { by, at, action: 'send_claimed' }, meta.state)];
      const body = { send_claim: claim, send_claimed_at: at.toISOString(), version, history, updated_at: at.toISOString() };
      if (!(await patch(id, meta, { status: SENDABLE, or: notHeld(at) }, body))) return { kind: 'conflict' };
      metas.set(id, { ...meta, version, history });
      return { kind: 'claimed', claim };
    },

    async releaseSend(id, claim, by, at) {
      const meta = metas.get(id);
      if (meta === undefined) return;
      const version = meta.version + 1;
      const history = [...meta.history, entry(version, { by, at, action: 'send_released' }, meta.state)];
      const body = { send_claim: null, send_claimed_at: null, version, history, updated_at: at.toISOString() };
      if (await patch(id, meta, { send_claim: `eq.${claim}` }, body)) metas.set(id, { ...meta, version, history });
    },
  };
}
