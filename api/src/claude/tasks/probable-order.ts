// #65: tarefa do Claude (#66, #171) que pede ao Claude a ordem provável da nota sem ordem (E5).
// #65: a tarefa não grava nem decide; o laço registra a linha em claude_suggestions e o Worker,
// #65 com a regra (resolveProbableOrder), confirma ou recusa a sugestão.
import type { Ask } from '../client.js';
import type { ClaudeTask } from '../task.js';
import { buildProbableOrderPrompt, parseProbableOrderAnswer } from '../../agent/probable-order.js';
import { ErpPurchasingConnector } from '../../connectors/erp-purchasing.js';
import { PROBABLE_ORDER_TASK } from '../../connectors/probable-order-suggestions.js';
import { SefazConnector } from '../../connectors/sefaz.js';
import type { SupabaseRest } from '../../connectors/supabase-rest.js';
import { candidateOrders, type CheckContext } from '../../domain/index.js';

/** #65: o que o prompt precisa, já serializado: o system, a nota com as candidatas e o schema. */
export type ProbableOrderInput = { system: string; prompt: string; schema: Record<string, unknown> };

/** #65: a resposta do Claude, validada à mão; o Worker lê `output.orderId` e `output.reason`. */
export type ProbableOrderOutput = { orderId: string | null; reason: string };

const keysOf = (rows: unknown[], column: string): Set<string> =>
  new Set(
    rows.flatMap((r) => {
      const value = typeof r === 'object' && r !== null ? (r as Record<string, unknown>)[column] : undefined;
      return typeof value === 'string' ? [value] : [];
    }),
  );

/** #65 A tarefa lê pelo SupabaseRest dos conectores, o mesmo que o Cron já tem. */
export const probableOrderTask = (rest: SupabaseRest): ClaudeTask<ProbableOrderInput, ProbableOrderOutput> => ({
  name: PROBABLE_ORDER_TASK,

  /** #65 AC-2: as notas com divergência E5 sem linha ok desta tarefa, e com ao menos uma candidata. */
  async pending() {
    const [divergences, done] = await Promise.all([
      rest.select('divergences', { select: 'invoice_access_key', filters: { classification: 'eq.E5' } }),
      rest.select('claude_suggestions', {
        select: 'input_key',
        filters: { task: `eq.${PROBABLE_ORDER_TASK}`, status: 'eq.ok' },
      }),
    ]);
    const answered = keysOf(done, 'input_key');
    const wanted = [...keysOf(divergences, 'invoice_access_key')].filter((k) => !answered.has(k));
    if (wanted.length === 0) return { requests: [], dropped: 0 };

    const [issued, purchaseOrders] = await Promise.all([
      new SefazConnector(rest).listIssuedInvoices(),
      new ErpPurchasingConnector(rest).listPurchaseOrders(),
    ]);
    const ctx: CheckContext = {
      purchaseOrders,
      suppliers: [],
      products: [],
      postedInvoices: [],
      payments: [],
      receipts: [],
      capturedInvoices: [],
    };
    const requests = issued
      .filter((invoice) => wanted.includes(invoice.accessKey))
      .flatMap((invoice) => {
        const candidates = candidateOrders(invoice, ctx);
        if (candidates.length === 0) return [];
        const { system, user, schema } = buildProbableOrderPrompt(invoice, candidates);
        return [{ key: invoice.accessKey, input: { system, prompt: user, schema } }];
      });
    return { requests, dropped: 0 };
  },

  /** #65 AC-3: pergunta e valida; resposta fora do formato lança, e o laço registra a linha de erro. */
  async run(input: ProbableOrderInput, ask: Ask): Promise<ProbableOrderOutput> {
    const answer = parseProbableOrderAnswer(await ask<unknown>(input));
    if (!answer) throw new Error('probable-order: resposta do Claude fora do formato');
    return answer;
  },
});
