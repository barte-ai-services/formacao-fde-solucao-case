// #65 AC-5: eval do acerto da ordem provável na base do kit, em duas metades.
// #65 predição (`npm run eval:predict`): Claude + regra em toda nota E5 do kit; a esteira publica o arquivo.
// #65 pontuação (`npm run eval:score`): compara com o gabarito, que vem de KIT_GABARITO e não entra no git.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { buildProbableOrderPrompt, parseProbableOrderAnswer } from '../src/agent/probable-order.js';
import {
  candidateOrders,
  confirmProbableOrder,
  resolveProbableOrder,
  type CheckContext,
  type InvoiceView,
  type ProbableOrderSuggestion,
} from '../src/domain/index.js';
import { checkNotaSemOrdem } from '../src/domain/checks/e5-nota-sem-ordem.js';
import { loadKit } from './kit.js';

export type Prediction = {
  readonly invoice: string;
  readonly accessKey: string;
  /** #65: a sugestão crua do Claude, ou null quando a chamada falhou. */
  readonly suggestion: ProbableOrderSuggestion | null;
  /** #65: linha de base sem o Claude, a primeira candidata que a regra confirma. */
  readonly ruleOnly: string | null;
  /** #65: a chamada ao Claude falhou nesta nota ('error'), ou null quando não falhou. */
  readonly claudeFailure: 'error' | null;
};

/** #65: a pergunta ao Claude, no formato do `askClaude` do executor da #66. */
export type AskJson = (input: { system: string; prompt: string; schema: Record<string, unknown> }) => Promise<unknown>;

const PREDICTIONS = env.EVAL_PREDICOES ?? 'eval-out/e5-predicoes.json';

const ruleOnly = (invoice: InvoiceView, ctx: CheckContext): string | null =>
  candidateOrders(invoice, ctx).find((o) => confirmProbableOrder(invoice, o, ctx).confirmed)?.id ?? null;

// #65: o Claude não roda no Worker nem neste processo; a predição recebe o `ask` do executor da #66 e
// #65 fica pulada até aquele PR entrar e passar o `askClaude` para cá.
const ask = null as AskJson | null;

async function predict(id: string, invoice: InvoiceView, ctx: CheckContext, run: AskJson): Promise<Prediction> {
  const base = { invoice: id, accessKey: invoice.accessKey, ruleOnly: ruleOnly(invoice, ctx) };
  const { system, user, schema } = buildProbableOrderPrompt(invoice, candidateOrders(invoice, ctx));
  try {
    const suggestion = parseProbableOrderAnswer(await run({ system, prompt: user, schema }));
    return { ...base, suggestion, claudeFailure: suggestion ? null : 'error' };
  } catch (error) {
    const { name, status, message } = (error ?? {}) as { name?: unknown; status?: unknown; message?: unknown };
    console.warn(
      `probable-order: ask falhou nota=${invoice.accessKey} name=${String(name)} status=${String(status)} ` +
        String(message ?? '').slice(0, 300),
    );
    return { ...base, suggestion: null, claudeFailure: 'error' };
  }
}

describe.skipIf(ask === null)('#65 AC-5 predição da ordem provável (Claude + regra)', () => {
  it('grava a predição de cada nota E5 do kit', async () => {
    const { invoices, ctx } = loadKit();
    const e5 = invoices.filter(({ invoice }) => checkNotaSemOrdem(invoice, ctx).length > 0);
    expect(e5.length).toBeGreaterThan(0);
    const predictions: Prediction[] = [];
    for (const { id, invoice } of e5) predictions.push(await predict(id, invoice, ctx, ask as AskJson));
    mkdirSync(new URL('../eval-out/', import.meta.url), { recursive: true });
    writeFileSync(PREDICTIONS, JSON.stringify(predictions, null, 2));
    // #65 AC-5: a predição não reprova a CI; as falhas do Claude vão por nota e a pontuação as conta.
    console.log(JSON.stringify(predictions, null, 2));
  });
});

type AnswerKeyRow = {
  nota_id: string; // ADR-001
  chave: string; // ADR-001
  classificacao: string; // ADR-001
  explicacao: string; // ADR-001
};

// #65 AC-5: a resposta certa. No match sem pedido, a ordem do mesmo fornecedor e destino com os mesmos
// #65 itens e quantidades; na E5 ou E7, nenhuma. As outras classes ficam fora do eval.
function expectedOrder(row: AnswerKeyRow, invoice: InvoiceView, ctx: CheckContext): string | null | undefined {
  if (row.classificacao === 'E5' || row.classificacao === 'E7') return null;
  if (row.classificacao !== 'match') return undefined;
  const key = (code: string, amount: number, unit: string) => `${code}|${amount}|${unit}`;
  const wanted = invoice.items.map((i) => key(i.supplierCode, i.quantity.amount, i.quantity.unit)).sort().join(';');
  const exact = ctx.purchaseOrders.filter(
    (o) =>
      o.supplierId === invoice.supplierId &&
      o.store === invoice.store &&
      o.items.map((i) => key(i.supplierCode, i.quantity.amount, i.quantity.unit)).sort().join(';') === wanted,
  );
  return exact.length === 1 ? exact[0]!.id : undefined;
}

describe.skipIf(!env.KIT_GABARITO)('#65 AC-5 pontuação da ordem provável contra o gabarito', () => {
  it('mede o acerto', () => {
    const { invoices, ctx } = loadKit();
    const byKey = new Map(invoices.map((k) => [k.invoice.accessKey, k.invoice]));
    const answerKey = new Map(
      (JSON.parse(readFileSync(env.KIT_GABARITO!, 'utf8')) as AnswerKeyRow[]).map((g) => [g.chave, g]),
    );
    // #65 AC-5: sem arquivo de predições, mede o produto como ele roda hoje, sem sugestão do Claude.
    const predictions: Prediction[] = existsSync(PREDICTIONS)
      ? (JSON.parse(readFileSync(PREDICTIONS, 'utf8')) as Prediction[])
      : invoices
          .filter(({ invoice }) => checkNotaSemOrdem(invoice, ctx).length > 0)
          .map(({ id, invoice }) => ({
            invoice: id,
            accessKey: invoice.accessKey,
            suggestion: null,
            ruleOnly: ruleOnly(invoice, ctx),
            claudeFailure: null,
          }));

    const rows = predictions.flatMap((p) => {
      const invoice = byKey.get(p.accessKey);
      const row = answerKey.get(p.accessKey);
      if (!invoice || !row) return [];
      const expected = expectedOrder(row, invoice, ctx);
      if (expected === undefined) return [];
      const resolved = resolveProbableOrder(invoice, ctx, p.suggestion ?? undefined);
      const product = resolved.kind === 'confirmada' ? resolved.orderId : null; // ADR-002
      return [
        {
          invoice: p.invoice,
          answerKey: row.classificacao,
          expected,
          product,
          ruleOnly: p.ruleOnly,
          claudeFailure: p.claudeFailure,
        },
      ];
    });

    const hits = rows.filter((r) => r.product === r.expected).length;
    const baseline = rows.filter((r) => r.ruleOnly === r.expected).length;
    const withOrder = rows.filter((r) => r.expected !== null);
    const falseSuggestions = rows.filter((r) => r.expected === null && r.product !== null).length;
    const failed = predictions.filter((p) => p.claudeFailure !== null).length;
    console.table(rows);
    console.log(
      [
        `casos: ${rows.length}`,
        `acerto: ${hits}/${rows.length}`,
        `acertoRegraSozinha: ${baseline}/${rows.length}`,
        `comOrdemAcertadas: ${withOrder.filter((r) => r.product === r.expected).length}/${withOrder.length}`,
        `sugestoesIndevidas: ${falseSuggestions}`,
        `chamadasFalhas: ${failed}/${predictions.length}`,
      ].join('\n'),
    );
    if (failed > 0) {
      console.warn(
        `aviso: ${failed} de ${predictions.length} chamadas ao Claude falharam; o acerto acima mede o produto com o Claude indisponível, não a sugestão dele.`,
      );
    }
    expect(rows.length).toBeGreaterThan(0);
  });
});
