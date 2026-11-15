// #65: tarefa do executor da #66 que pede ao Claude a ordem provável da nota sem ordem (E5).
// #65: a tarefa não grava nem decide; o executor registra a linha em claude_suggestions e o Worker,
// #65 com a regra (resolveProbableOrder), confirma ou recusa a sugestão.
// #65: '../task.js' e '../claude.js' são do executor da #66 e ligam quando o PR dele entrar na main.
import type { Ask } from '../claude.js';
import type { ClaudeTask } from '../task.js';
import { buildProbableOrderPrompt, parseProbableOrderAnswer } from '../../../../api/src/agent/probable-order.js';
import { ErpPurchasingConnector } from '../../../../api/src/connectors/erp-purchasing.js';
import { PROBABLE_ORDER_TASK } from '../../../../api/src/connectors/probable-order-suggestions.js';
import { SefazConnector } from '../../../../api/src/connectors/sefaz.js';
import type { SupabaseRest } from '../../../../api/src/connectors/supabase-rest.js';
import { candidateOrders, type CheckContext } from '../../../../api/src/domain/index.js';

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

export const probableOrderTask: ClaudeTask<ProbableOrderInput, ProbableOrderOutput> = {
  name: PROBABLE_ORDER_TASK,

  /** #65 AC-2: as notas com divergência E5 sem linha ok desta tarefa, e com ao menos uma candidata. */
  async pending(db) {
    // #65: o cliente do executor (#66) lê o PostgREST com o mesmo select do SupabaseRest dos conectores.
    const rest = db as unknown as SupabaseRest;
    const [divergences, done] = await Promise.all([
      rest.select('divergences', { select: 'invoice_access_key', filters: { classification: 'eq.E5' } }),
      rest.select('claude_suggestions', {
        select: 'input_key',
        filters: { task: `eq.${PROBABLE_ORDER_TASK}`, status: 'eq.ok' },
      }),
    ]);
    const answered = keysOf(done, 'input_key');
    const wanted = [...keysOf(divergences, 'invoice_access_key')].filter((k) => !answered.has(k));
    if (wanted.length === 0) return [];

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
    return issued
      .filter((invoice) => wanted.includes(invoice.accessKey))
      .flatMap((invoice) => {
        const candidates = candidateOrders(invoice, ctx);
        if (candidates.length === 0) return [];
        const { system, user, schema } = buildProbableOrderPrompt(invoice, candidates);
        return [{ key: invoice.accessKey, input: { system, prompt: user, schema } }];
      });
  },

  /** #65 AC-3: pergunta e valida; resposta fora do formato lança, e o executor registra a linha de erro. */
  async run(input: ProbableOrderInput, ask: Ask): Promise<ProbableOrderOutput> {
    const answer = parseProbableOrderAnswer(await ask<unknown>(input));
    if (!answer) throw new Error('probable-order: resposta do Claude fora do formato');
    return answer;
  },
};
