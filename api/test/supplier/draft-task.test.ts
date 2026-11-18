// #156: testes da tarefa do Cron (api/src/supplier/draft-task.ts); o caminho do rascunho tem os seus em draft.test.ts.
import { describe, expect, it } from 'vitest';
import { ClaudeError } from '../../src/claude/client.js';
import type { Db } from '../../src/claude/db.js';
import { supplierRequestDraftTask } from '../../src/supplier/draft-task.js';
import { GOOD_TEXT, draftInput, fakeAsk, fakeMailer, queueView, world } from './doubles.js';

const db: Db = { select: async () => [], upsert: async () => [] };

describe('#156 a tarefa lista as devoluções pendentes sem pedido aberto', () => { // ADR-002
  it('uma chave estável por devolução da fila', async () => { // ADR-002
    const w = world(fakeMailer(), [queueView(7), queueView(8, { status: 'emitida' })]);
    const { requests, dropped } = await supplierRequestDraftTask(w.deps).pending(db);
    expect(requests.map((r) => r.key)).toEqual(['return_note:7']);
    expect(requests[0]?.input).toEqual(draftInput());
    expect(dropped).toBe(0);
  });

  it('pula a devolução cuja nota de origem já tem pedido aberto', async () => { // ADR-002
    const w = world();
    const task = supplierRequestDraftTask(w.deps);
    await task.run(draftInput(), fakeAsk());
    expect((await task.pending(db)).requests).toEqual([]);
  });

  it('devolução que a regra não monta falha para o laço registrar o erro, sem rascunho', async () => { // ADR-002
    const lines = [{ supplierCode: 'X-1', description: 'x', quantity: { amount: 1, unit: 'UN' as const }, valueCents: null }];
    const w = world(fakeMailer(), [queueView(7, { lines })]);
    await expect(supplierRequestDraftTask(w.deps).run(draftInput({ lines }), fakeAsk())).rejects.toThrow();
    expect(w.requests.rows).toEqual([]);
  });
});

describe('#156 o custo do Cron: poucas leituras, e a entrada da tarefa basta para o rascunho', () => { // ADR-002
  it('pending lê a fila e os pedidos abertos uma vez cada, sem findOpen por devolução', async () => { // ADR-002
    const w = world(fakeMailer(), [queueView(7), queueView(8, { invoiceAccessKey: 'outra-chave' }), queueView(9, { invoiceAccessKey: 'mais-uma' })]);
    let listCalls = 0;
    const inner = w.queue.list;
    w.queue.list = async (...args) => {
      listCalls += 1;
      return inner(...args);
    };
    await supplierRequestDraftTask(w.deps).pending(db);
    expect([listCalls, w.requests.listOpenKeysCalls, w.requests.findOpenCalls]).toEqual([1, 1, 0]);
  });

  it('pergunta pelos pedidos abertos só das notas pendentes (sem pendente, pergunta por nenhuma)', async () => { // ADR-002
    const w = world(fakeMailer(), [queueView(7), queueView(8, { invoiceAccessKey: 'outra-chave' }), queueView(9, { status: 'emitida', invoiceAccessKey: 'emitida' })]);
    await supplierRequestDraftTask(w.deps).pending(db);
    expect(w.requests.listOpenKeysArgs).toEqual([[queueView(7).invoiceAccessKey, 'outra-chave']]);
    const empty = world(fakeMailer(), [queueView(9, { status: 'emitida' })]);
    expect((await supplierRequestDraftTask(empty.deps).pending(db)).requests).toEqual([]);
    expect(empty.requests.listOpenKeysArgs).toEqual([[]]); // #156: o adaptador não lê com lista vazia (supabase-store.test.ts)
  });

  it('a entrada leva o que o run precisa da fila: id, chave de acesso e linhas', async () => { // ADR-002
    const w = world();
    const { requests } = await supplierRequestDraftTask(w.deps).pending(db);
    expect(requests[0]?.input).toEqual({
      queueId: 7,
      invoiceAccessKey: queueView(7).invoiceAccessKey,
      lines: [
        { supplierCode: 'F02-002', amount: 7, unit: 'UN' },
        { supplierCode: 'F02-005', amount: 5, unit: 'CX' },
      ],
    });
  });

  it('o run com a entrada do pending cria o rascunho sem reler a fila nem o pedido aberto', async () => { // ADR-002
    const w = world();
    const task = supplierRequestDraftTask(w.deps);
    const { requests } = await task.pending(db);
    let listCalls = 0;
    const inner = w.queue.list;
    w.queue.list = async (...args) => {
      listCalls += 1;
      return inner(...args);
    };
    const out = await task.run(requests[0]!.input, fakeAsk());
    expect(out).toMatchObject({ status: 'draft' });
    expect([listCalls, w.requests.findOpenCalls]).toEqual([0, 0]);
  });

  it('a corrida com outro pedido criado entre o pending e o run vira skipped pelo conflito do create', async () => { // ADR-002
    const w = world();
    const task = supplierRequestDraftTask(w.deps);
    const { requests } = await task.pending(db);
    await task.run(requests[0]!.input, fakeAsk());
    await expect(task.run(requests[0]!.input, fakeAsk())).resolves.toEqual({ skipped: 'open_request_exists' });
  });

  it('a tarefa pede no máximo 2 pedidos por rodada, para a rodada caber nos 50 subrequests', () => { // ADR-002
    expect(supplierRequestDraftTask(world().deps).limit).toBe(2);
  });
});

describe('#156 texto do Claude recusado pelo catálogo', () => { // ADR-002
  it('a tarefa volta normalmente com o pedido descartado (os motivos estão em draft.test.ts)', async () => { // ADR-002
    const w = world();
    const bad = { ...GOOD_TEXT, body: 'Devolvemos 999 caixas.' };
    await expect(supplierRequestDraftTask(w.deps).run(draftInput(), fakeAsk(bad))).resolves.toMatchObject({ status: 'discarded' });
  });

  it('o descartado não conta como aberto: a devolução volta à lista da tarefa', async () => { // ADR-002
    const w = world();
    const task = supplierRequestDraftTask(w.deps);
    await task.run(draftInput(), fakeAsk({ subject: 'oi' }));
    expect((await task.pending(db)).requests).toHaveLength(1);
  });
});

describe('#156 sem credencial, 401 ou 429 não deixa rascunho', () => { // ADR-002
  it.each([
    ['auth', 401],
    ['rate_limit', 429],
  ] as const)('o erro %s do Claude sobe como está e nada é criado', async (kind, status) => { // ADR-002
    const w = world();
    const failure = new ClaudeError(kind, 'recusado', status);
    await expect(supplierRequestDraftTask(w.deps).run(draftInput(), fakeAsk(failure))).rejects.toBe(failure);
    expect(w.requests.rows).toEqual([]);
  });
});
