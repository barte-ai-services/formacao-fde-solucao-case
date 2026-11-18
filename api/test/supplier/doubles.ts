import type { Ask } from '../../src/claude/client.js';
import {
  SupplierRequest,
  issueReturnNote,
  type IssuedReturnNote,
  type RequestStatus,
  type ReturnNoteDraft,
} from '../../src/domain/index.js';
import type { ReturnNoteQueue, ReturnNoteStatus, ReturnNoteView, TransitionResult } from '../../src/returns/return-notes.js';
import type {
  CreateResult,
  MailMessage,
  MailResult,
  NewRequest,
  RequestChange,
  RequestRecord,
  SupplierDeps,
} from '../../src/supplier/ports.js';
import { queueEntryOf } from '../../src/supplier/draft.js';
import type { SupplierDraftInput } from '../../src/supplier/draft-task.js';
import { SOURCE_KEY, sourceInvoice } from '../domain/supplier-request-fixtures.js';

// #11: dublês das portas do pedido ao fornecedor; nenhum banco, nenhuma rede.

export const NOW = new Date('2026-11-12T15:00:00Z');
export const SUPPLIER_EMAIL = 'compras@bebidas-rio-claro.example';

/** #11: o texto que o Claude falso devolve; todo número é {{chave}} do catálogo. */
export const GOOD_TEXT = {
  subject: 'Devolução da nota {{nota.numero}}',
  body: 'Devolvemos {{devolucao.item[F02-002].quantidade}} de F02-002, no valor de {{devolucao.item[F02-002].valor}}. Total {{devolucao.total}}, retorno até {{prazo}}.',
  asks: ['Confirmar o recebimento da nota de devolução', 'Creditar {{devolucao.total}} até {{prazo}}'],
};

export type FakeAsk = Ask & { calls: unknown[] };

export const fakeAsk = (answer: unknown = GOOD_TEXT): FakeAsk => {
  const calls: unknown[] = [];
  const ask = (async (options: unknown) => {
    calls.push(options);
    if (answer instanceof Error) throw answer;
    return answer;
  }) as FakeAsk;
  ask.calls = calls;
  return ask;
};

export const queueView = (id: number, overrides: Partial<ReturnNoteView> = {}): ReturnNoteView => ({
  id,
  status: 'pendente',
  invoiceAccessKey: SOURCE_KEY,
  invoiceNumber: '43894',
  supplierId: 'F02',
  reason: 'item trocado',
  lines: [
    { supplierCode: 'F02-002', description: 'Refrigerante cola 2 L', quantity: { amount: 7, unit: 'UN' }, valueCents: 5943 },
    { supplierCode: 'F02-005', description: 'Arroz 5 kg', quantity: { amount: 5, unit: 'CX' }, valueCents: 50000 },
  ],
  valueCents: 55943,
  publishedAt: '2026-11-12T10:00:00Z',
  pendingSeconds: 0,
  emitted: null,
  cancelled: null,
  ...overrides,
});

/** #12: a entrada que o `pending()` da tarefa entrega ao `run`, para a devolução 7 (ou a que `over` descreve). */
export const draftInput = (over: Partial<ReturnNoteView> = {}): SupplierDraftInput => {
  const { id, ...rest } = queueEntryOf(queueView(7, over));
  return { queueId: id, ...rest };
};

export type FakeQueue = ReturnNoteQueue & { views: ReturnNoteView[]; emitCalls: unknown[][] };

export const fakeQueue = (views: ReturnNoteView[]): FakeQueue => {
  const queue: FakeQueue = {
    views,
    emitCalls: [],
    list: async (status: ReturnNoteStatus) => queue.views.filter((v) => v.status === status),
    emit: async (id, number, by, now): Promise<TransitionResult> => {
      queue.emitCalls.push([id, number, by, now]);
      const view = queue.views.find((v) => v.id === id);
      if (view === undefined) return { kind: 'not_found' };
      if (view.status !== 'pendente') return { kind: 'conflict' };
      view.status = 'emitida';
      view.emitted = { number, by, at: now.toISOString() };
      return { kind: 'ok', note: view };
    },
    cancel: async () => ({ kind: 'conflict' }),
  };
  return queue;
};

type Stored = RequestRecord & { stamps: RequestChange[]; claim: string | null };

export type FakeRequests = SupplierDeps['requests'] & {
  rows: Stored[];
  saves: number;
  claims: number;
  releases: number;
  /** #12: o que o caso de uso mandou criar, para conferir quem fez. */
  created: NewRequest[];
  /** #12: quando true, o próximo save diz `stale`, como o PATCH que não achou a versão lida. */
  staleNext: boolean;
  /** #12: quando true, a próxima trava é recusada (outro envio em curso). */
  refuseClaim: boolean;
  /** #12: quantas vezes cada leitura foi chamada, para conferir o custo do `pending()` da tarefa. */
  findOpenCalls: number;
  listOpenKeysCalls: number;
  /** #12: as chaves que cada `listOpenKeys` recebeu, para conferir que só as pendentes foram perguntadas. */
  listOpenKeysArgs: string[][];
};

export const fakeRequests = (): FakeRequests => {
  const rows: Stored[] = [];
  const store: FakeRequests = {
    rows,
    saves: 0,
    claims: 0,
    releases: 0,
    created: [],
    staleNext: false,
    refuseClaim: false,
    findOpenCalls: 0,
    listOpenKeysCalls: 0,
    listOpenKeysArgs: [],
    findOpen: async (key, type) => {
      store.findOpenCalls += 1;
      return rows.find((r) => r.request.invoiceAccessKey === key && r.request.requestType === type && r.request.isOpen) ?? null;
    },
    listOpenKeys: async (type, keys) => {
      store.listOpenKeysCalls += 1;
      store.listOpenKeysArgs.push([...keys]);
      return new Set(
        rows.filter((r) => r.request.requestType === type && r.request.isOpen && keys.includes(r.request.invoiceAccessKey)).map((r) => r.request.invoiceAccessKey),
      );
    },
    get: async (id) => rows.find((r) => r.request.id === id) ?? null,
    findLatest: async (key, type) => [...rows].reverse().find((r) => r.request.invoiceAccessKey === key && r.request.requestType === type) ?? null,
    listByStatus: async (status, limit) => [...rows].reverse().filter((r) => r.request.status === status).slice(0, limit),
    create: async (input: NewRequest): Promise<CreateResult> => {
      store.created.push(input);
      const opens = input.outcome.kind === 'draft';
      if (opens && rows.some((r) => r.request.invoiceAccessKey === input.invoiceAccessKey && r.request.isOpen)) {
        return { kind: 'conflict' };
      }
      const base = { id: rows.length + 41, invoiceAccessKey: input.invoiceAccessKey, note: input.note, draftedOn: input.draftedOn };
      const request =
        input.outcome.kind === 'draft'
          ? SupplierRequest.draft({ ...base, text: input.outcome.text })
          : SupplierRequest.rejected({ ...base, rejection: input.outcome.rejection });
      const row: Stored = { request, queueId: input.queueId, to: input.to, stamps: [], claim: null };
      rows.push(row);
      return { kind: 'ok', record: row };
    },
    save: async (request, change) => {
      if (store.staleNext) {
        store.staleNext = false;
        return 'stale';
      }
      const row = rows.find((r) => r.request === request);
      // #12: a trava é explícita: com chave, só grava quem a tem; sem chave, só grava com a trava livre.
      if (row !== undefined && row.claim !== (change.claim ?? null)) return 'stale';
      store.saves += 1;
      if (row !== undefined) {
        row.stamps.push(change);
        if (change.action === 'sent' || change.action === 'send_failed') row.claim = null;
      }
      return 'ok';
    },
    claimSend: async (id) => {
      store.claims += 1;
      const row = rows.find((r) => r.request.id === id);
      if (row === undefined || store.refuseClaim || row.claim !== null) return { kind: 'conflict' };
      row.claim = `claim-${store.claims}`;
      return { kind: 'claimed', claim: row.claim };
    },
    releaseSend: async (id, claim) => {
      store.releases += 1;
      const row = rows.find((r) => r.request.id === id);
      if (row !== undefined && row.claim === claim) row.claim = null;
    },
  };
  return store;
};

export type FakeNotes = SupplierDeps['notes'] & { issuedCount: number };

export const fakeNotes = (): FakeNotes => {
  const byQueue = new Map<number, IssuedReturnNote>();
  const notes: FakeNotes = {
    issuedCount: 0,
    issue: async (queueId: number, draft: ReturnNoteDraft, issuedOn: string) => {
      const known = byQueue.get(queueId);
      if (known !== undefined) return known;
      notes.issuedCount += 1;
      const issued = issueReturnNote(draft, { sequence: 100 + notes.issuedCount, issuedOn });
      byQueue.set(queueId, issued);
      return issued;
    },
  };
  return notes;
};

export type FakeMailer = SupplierDeps['mailer'] & { sent: MailMessage[]; outcomes: Array<MailResult | Error> };

/** #11: cada envio consome o próximo resultado programado; sem nenhum, o envio dá certo pelo mock. */
export const fakeMailer = (...outcomes: Array<MailResult | Error>): FakeMailer => {
  const mailer: FakeMailer = {
    sent: [],
    outcomes,
    send: async (message) => {
      mailer.sent.push(message);
      const next = mailer.outcomes.shift() ?? { ok: true, channel: 'mock', providerMessageId: `mock-${mailer.sent.length}` };
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return mailer;
};

export type World = {
  deps: SupplierDeps;
  queue: FakeQueue;
  requests: FakeRequests;
  notes: FakeNotes;
  mailer: FakeMailer;
};

export const world = (mailer: FakeMailer = fakeMailer(), views: ReturnNoteView[] = [queueView(7)]): World => {
  const queue = fakeQueue(views);
  const requests = fakeRequests();
  const notes = fakeNotes();
  const deps: SupplierDeps = {
    queue,
    requests,
    notes,
    mailer,
    source: { find: async (key) => (key === SOURCE_KEY ? { invoice: sourceInvoice(), supplierEmail: SUPPLIER_EMAIL } : null) },
    clock: { now: () => NOW },
  };
  return { deps, queue, requests, notes, mailer };
};

export const statusOf = (w: World, id: number): RequestStatus | undefined =>
  w.requests.rows.find((r) => r.request.id === id)?.request.status;
