// #11: a tarefa do Claude (#66, #171) que prepara o rascunho do pedido ao fornecedor (#2/AC-1).
// #11: a tarefa não emite nem envia; o laço registra a linha em claude_suggestions e a pessoa decide.
import type { Ask } from '../claude/client.js';
import type { ClaudeTask } from '../claude/task.js';
import type { RequestStatus } from '../domain/index.js';
import { draftFromEntry, queueEntryOf, type QueueEntry } from './draft.js';
import type { SupplierDeps } from './ports.js';

/** #12: a entrada da tarefa é a devolução da fila que o `pending()` já leu (id, chave da nota, linhas); o `run` não relê a fila. */
export type SupplierDraftInput = { readonly queueId: number } & Omit<QueueEntry, 'id'>;

/** #11: o que a tarefa deixa registrado: o pedido criado e o estado dele, ou o motivo de não ter criado. */
export type SupplierDraftOutput =
  | { readonly requestId: number; readonly status: RequestStatus }
  | { readonly skipped: 'open_request_exists' | 'queue_not_pending' };

export const SUPPLIER_DRAFT_TASK = 'supplier-request-draft';

/** #11/AC-1: o nome da chave estável por devolução da fila. */
export const draftKey = (queueId: number): string => `return_note:${queueId}`;

/** #12: pedidos por rodada: com 2, o rascunho custa 14 das 50 subrequests da rodada (contas em api/src/claude/cron.ts). */
export const SUPPLIER_DRAFT_LIMIT = 2;

export const supplierRequestDraftTask = (deps: SupplierDeps): ClaudeTask<SupplierDraftInput, SupplierDraftOutput> => ({
  name: SUPPLIER_DRAFT_TASK,
  limit: SUPPLIER_DRAFT_LIMIT,

  /** #11/AC-1: cada devolução `pendente` da fila sem pedido `return_note` aberto na nota de origem. */
  async pending() {
    // #12: três leituras, qualquer que seja o número de devoluções: a fila (que lê as notas de origem em outra) e, em seguida, os pedidos abertos só dessas notas.
    const entries = (await deps.queue.list('pendente', deps.clock.now())).map(queueEntryOf);
    const open = await deps.requests.listOpenKeys('return_note', entries.map((e) => e.invoiceAccessKey));
    const requests = entries
      .filter((e) => !open.has(e.invoiceAccessKey))
      .map(({ id, ...rest }) => ({ key: draftKey(id), input: { queueId: id, ...rest } }));
    return { requests, dropped: 0 };
  },

  /** #11/AC-2: texto recusado volta normalmente (pedido descartado); erro do Claude e dado quebrado lançam. */
  async run(input: SupplierDraftInput, ask: Ask): Promise<SupplierDraftOutput> {
    const { queueId, ...rest } = input;
    const result = await draftFromEntry(deps, { id: queueId, ...rest }, ask);
    if (result.kind === 'ok') return { requestId: result.record.request.id, status: result.record.request.status };
    if (result.kind === 'conflict') return { skipped: result.reason };
    throw new Error(`supplier-request-draft: devolução ${input.queueId} não vira rascunho (${result.kind})`);
  },
});
