// #353 O pedido de devolução de valor pequeno sai sozinho no modo demonstração: o módulo puro do passo (portas, relógio injetados).
import { describe, expect, it } from 'vitest';
import {
  AUTO_RETURN_COST,
  AUTO_RETURN_STEP_NAME,
  autoReturnStep,
  planAutoReturns,
  type AutoReturnQueue,
  type AutoReturnSend,
  type PendingReturn,
} from '../../src/demo/auto-return.js';
import { buildSupplierRequestFacts, validateRequestText } from '../../src/domain/index.js';
import { SOURCE_KEY, sourceInvoice } from '../domain/supplier-request-fixtures.js';

const NOW = new Date('2026-11-23T15:00:00Z'); // segunda-feira
const clock = () => NOW;
const LIMIT_5K = 500_000;

/** #353 A devolução pendente da fila: `cx` caixas do item F02-005 a R$ 100,00 cada (cx = 50 dá exatamente R$ 5.000,00). */
const pending = (queueId: number, cx: number, over: Partial<PendingReturn> = {}): PendingReturn => ({
  queueId,
  invoice: sourceInvoice(),
  lines: [{ supplierCode: 'F02-005', amount: cx, unit: 'CX' }],
  supplierEmail: 'compras@fornecedor.example',
  request: null,
  ...over,
});
const queue = (entries: PendingReturn[], limitCents = LIMIT_5K): AutoReturnQueue => ({ limitCents, entries });

function doubles(q: AutoReturnQueue) {
  const log: string[] = [];
  const written: AutoReturnSend[][] = [];
  return {
    log,
    written,
    source: { listPending: async () => (log.push('lê'), q) },
    sink: { sendBatch: async (batch: readonly AutoReturnSend[]) => (log.push('grava'), written.push([...batch]), batch.length) },
  };
}
const run = async (q: AutoReturnQueue, batchLimit?: number) => {
  const d = doubles(q);
  await autoReturnStep({ source: d.source, sink: d.sink, clock, ...(batchLimit === undefined ? {} : { batchLimit }) }).run();
  return d;
};

describe('#353/AC-1 o pedido de devolução de até o limite é emitido e enviado sem clique', () => {
  it('#353/AC-1: o pedido de R$ 559,43 sai sozinho: uma leitura e uma gravação em lote, com a nota, o e-mail do fornecedor e o texto', async () => {
    const entry = pending(7, 5, { lines: [{ supplierCode: 'F02-002', amount: 7, unit: 'UN' }, { supplierCode: 'F02-005', amount: 5, unit: 'CX' }] });
    const d = await run(queue([entry]));
    expect(d.log).toEqual(['lê', 'grava']);
    const [send] = d.written[0] ?? [];
    expect(send).toMatchObject({
      queueId: 7,
      invoiceAccessKey: SOURCE_KEY,
      supplierId: 'F02',
      recipient: 'compras@fornecedor.example',
      requestId: null,
      requestVersion: null,
      draftedOn: '2026-11-23',
      dueOn: '2026-11-26',
    });
    expect(send?.note).toMatchObject({ nature: 'devolucao', referencedAccessKey: SOURCE_KEY, total: 559.43 });
  });

  it('#353/AC-1: no limite exato (R$ 5.000,00) o pedido sai: "até" inclui o limite', async () => {
    const d = await run(queue([pending(1, 50)]));
    expect(d.written[0]?.map((s) => s.queueId)).toEqual([1]);
  });

  it('#353/AC-1: o texto do pedido automático passa pela mesma conferência do texto do Claude (todo número é {{chave}} do catálogo)', async () => {
    const d = await run(queue([pending(1, 5)]));
    const [send] = d.written[0] ?? [];
    if (!send) throw new Error('nada saiu');
    const catalog = buildSupplierRequestFacts(send.note, sourceInvoice(), send.dueOn);
    expect(validateRequestText(send.text, catalog).ok).toBe(true);
  });

  it('#353/AC-1: o rascunho que o Claude já deixou na nota é o que sai (mesmo texto, mesma versão), em vez de um segundo pedido', async () => {
    const note = (await run(queue([pending(1, 5)]))).written[0]?.[0];
    if (!note) throw new Error('nada saiu');
    const draft = { id: 31, version: 2, draftedOn: '2026-11-23', text: note.text };
    const d = await run(queue([pending(1, 5, { request: draft })]));
    expect(d.written[0]?.[0]).toMatchObject({ requestId: 31, requestVersion: 2, text: note.text });
  });

  it('#353/AC-1: o rascunho cujo texto não confere com a nota não sai, e não derruba os outros do lote', async () => {
    const bad = { id: 9, version: 1, draftedOn: '2026-11-23', text: { subject: 'Valor {{inexistente}}', body: 'x', asks: ['y'] } };
    const d = await run(queue([pending(1, 5, { request: bad }), pending(2, 5)]));
    expect(d.written[0]?.map((s) => s.queueId)).toEqual([2]);
  });

  it('#353/AC-1: a devolução que a regra não monta (linha que a nota não tem) é pulada, e as outras saem', async () => {
    const broken = pending(1, 5, { lines: [{ supplierCode: 'NAO-EXISTE', amount: 1, unit: 'UN' }] });
    const d = await run(queue([broken, pending(2, 5)]));
    expect(d.written[0]?.map((s) => s.queueId)).toEqual([2]);
  });

  it('#353/AC-1: o lote é limitado (50 por rodada, ou o teto dado), do mais antigo para o mais novo', async () => {
    const many = Array.from({ length: 60 }, (_, i) => pending(i + 1, 1));
    expect((await run(queue(many))).written[0]).toHaveLength(50);
    expect((await run(queue(many), 3)).written[0]?.map((s) => s.queueId)).toEqual([1, 2, 3]);
  });
});

describe('#353/AC-2 acima do limite nada muda', () => {
  it('#353/AC-2: um centavo acima do limite fica com a pessoa: lê, e não grava nada', async () => {
    const d = await run(queue([pending(1, 50)], LIMIT_5K - 1));
    expect(d.log).toEqual(['lê']);
    expect(d.written).toEqual([]);
  });

  it('#353/AC-2: no mesmo lote, só o que cabe no limite sai; o maior continua pendente', async () => {
    const d = await run(queue([pending(1, 51), pending(2, 5), pending(3, 80)]));
    expect(d.written[0]?.map((s) => s.queueId)).toEqual([2]);
  });
});

describe('#353/AC-3 o limite vem do banco: muda sem deploy, e zero desliga', () => {
  it('#353/AC-3: o limite é o que a leitura trouxe: com R$ 10.000,00 o pedido de R$ 6.000,00 sai, com R$ 500,00 o de R$ 559,43 não', async () => {
    const big = pending(1, 60);
    expect((await run(queue([big], 1_000_000))).written[0]?.map((s) => s.queueId)).toEqual([1]);
    expect((await run(queue([big], 500_000))).written).toEqual([]);
    const small = pending(2, 5, { lines: [{ supplierCode: 'F02-002', amount: 7, unit: 'UN' }, { supplierCode: 'F02-005', amount: 5, unit: 'CX' }] });
    expect((await run(queue([small], 50_000))).written).toEqual([]);
  });

  it('#353/AC-3: limite zero desliga: nenhum pedido sai, por menor que seja', async () => {
    const d = await run(queue([pending(1, 1)], 0));
    expect(d.written).toEqual([]);
  });

  it('#353/AC-3: o passo de rodada declara o nome e o custo (uma leitura e uma gravação) e planeja pelo relógio injetado', () => {
    expect(AUTO_RETURN_COST).toBe(2);
    const step = autoReturnStep({ ...doubles(queue([])), clock });
    expect([step.name, step.maxSubrequests]).toEqual([AUTO_RETURN_STEP_NAME, AUTO_RETURN_COST]);
    expect(planAutoReturns(queue([pending(1, 5)]), { clock })).toHaveLength(1);
    expect(planAutoReturns(queue([pending(1, 5)], 0), { clock })).toEqual([]);
  });
});
