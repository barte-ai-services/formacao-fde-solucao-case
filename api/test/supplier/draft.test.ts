import { describe, expect, it } from 'vitest';
import { ClaudeError } from '../../src/claude/client.js';
import { draftRequest, todayIso } from '../../src/supplier/draft.js';
import { GOOD_TEXT, SUPPLIER_EMAIL, fakeAsk, fakeMailer, queueView, statusOf, world } from './doubles.js';

// #156: testes do caminho único do rascunho (api/src/supplier/draft.ts), chamado direto, sem a tarefa.

describe('#156 o rascunho nasce da devolução pendente', () => { // ADR-002
  it('grava um rascunho com a nota montada pela regra e o e-mail do Claude, para o e-mail do fornecedor', async () => { // ADR-002
    const w = world();
    const ask = fakeAsk();
    const result = await draftRequest(w.deps, 7, ask);
    expect(result.kind).toBe('ok');
    const [row] = w.requests.rows;
    expect(row?.request.status).toBe('draft');
    expect(row?.request.note.total).toBe(559.43);
    expect(row?.request.note.items.map((i) => i.supplierCode)).toEqual(['F02-002', 'F02-005']);
    expect(row?.request.subject).toBe(GOOD_TEXT.subject);
    expect(row?.request.dueOn).toBe('2026-11-17');
    expect(row?.queueId).toBe(7);
    expect(row?.to).toBe(SUPPLIER_EMAIL);
    expect(ask.calls).toHaveLength(1);
  });

  it('queue_not_pending: devolução que não está pendente na fila é conflito e o Claude nem é chamado', async () => { // ADR-002
    const w = world(fakeMailer(), [queueView(7, { status: 'emitida' })]);
    const ask = fakeAsk();
    expect(await draftRequest(w.deps, 7, ask)).toEqual({ kind: 'conflict', reason: 'queue_not_pending' });
    expect(await draftRequest(w.deps, 99, ask)).toEqual({ kind: 'conflict', reason: 'queue_not_pending' });
    expect(ask.calls).toEqual([]);
    expect(w.requests.rows).toEqual([]);
  });

  it('open_request_exists: nota de origem com pedido aberto é conflito e o Claude nem é chamado', async () => { // ADR-002
    const w = world();
    await draftRequest(w.deps, 7, fakeAsk());
    const ask = fakeAsk();
    expect(await draftRequest(w.deps, 7, ask)).toEqual({ kind: 'conflict', reason: 'open_request_exists' });
    expect(ask.calls).toEqual([]);
    expect(w.requests.rows).toHaveLength(1);
  });

  it('source_missing: nota de origem que o cadastro não devolve é invalid, sem chamar o Claude', async () => { // ADR-002
    const w = world();
    const ask = fakeAsk();
    const result = await draftRequest({ ...w.deps, source: { find: async () => null } }, 7, ask);
    expect(result).toEqual({ kind: 'invalid', reason: 'source_missing' });
    expect(ask.calls).toEqual([]);
    expect(w.requests.rows).toEqual([]);
  });

  it('note_not_buildable: devolução que a regra não monta é invalid, sem chamar o Claude nem gravar', async () => { // ADR-002
    const lines = [{ supplierCode: 'X-1', description: 'x', quantity: { amount: 1, unit: 'UN' as const }, valueCents: null }];
    const w = world(fakeMailer(), [queueView(7, { lines })]);
    const ask = fakeAsk();
    expect(await draftRequest(w.deps, 7, ask)).toEqual({ kind: 'invalid', reason: 'note_not_buildable' });
    expect(ask.calls).toEqual([]);
    expect(w.requests.rows).toEqual([]);
  });

  it('o erro do Claude sobe como está e nada é gravado', async () => { // ADR-002
    const w = world();
    const failure = new ClaudeError('auth', 'recusado', 401);
    await expect(draftRequest(w.deps, 7, fakeAsk(failure))).rejects.toBe(failure);
    expect(w.requests.rows).toEqual([]);
  });
});

describe('#156 texto do Claude recusado pelo catálogo', () => { // ADR-002
  it('número fora do catálogo: o pedido nasce descartado, com o motivo', async () => { // ADR-002
    const w = world();
    const bad = { ...GOOD_TEXT, body: 'Devolvemos 999 caixas.' };
    const result = await draftRequest(w.deps, 7, fakeAsk(bad));
    expect(result.kind === 'ok' && result.record.request.status).toBe('discarded');
    expect(statusOf(w, 41)).toBe('discarded');
    expect(w.requests.rows[0]?.request.discardReason).toBe('number_mismatch: body');
  });

  it('resposta sem a forma pedida também nasce descartada', async () => { // ADR-002
    const w = world();
    await draftRequest(w.deps, 7, fakeAsk({ subject: 'oi' }));
    expect(w.requests.rows[0]?.request.discardReason).toBe('invalid_shape: body');
  });

  it('o descartado não conta como aberto: um novo rascunho da mesma nota é aceito', async () => { // ADR-002
    const w = world();
    await draftRequest(w.deps, 7, fakeAsk({ subject: 'oi' }));
    expect((await draftRequest(w.deps, 7, fakeAsk())).kind).toBe('ok');
    expect(statusOf(w, 42)).toBe('draft');
  });
});

describe('#156 preparar o rascunho não emite nem envia', () => { // ADR-002
  it('nenhuma nota emitida, nenhuma fila movida, nenhum e-mail', async () => { // ADR-002
    const w = world();
    await draftRequest(w.deps, 7, fakeAsk());
    expect(w.notes.issuedCount).toBe(0);
    expect(w.queue.emitCalls).toEqual([]);
    expect(w.mailer.sent).toEqual([]);
    expect(w.queue.views[0]?.status).toBe('pendente');
  });
});

describe('#156 o dia do rascunho é o dia de São Paulo', () => { // ADR-002
  it('todayIso: pouco depois da meia-noite UTC ainda é o dia anterior em São Paulo', () => { // ADR-002
    expect(todayIso(new Date('2026-11-13T02:30:00Z'))).toBe('2026-11-12');
    expect(todayIso(new Date('2026-11-13T03:00:00Z'))).toBe('2026-11-13');
  });

  it('o rascunho feito às 23h30 de São Paulo (02h30 UTC) usa o dia de São Paulo, e o prazo conta a partir dele (pelo dia UTC seria 2026-11-18)', async () => { // ADR-002
    const w = world();
    const result = await draftRequest({ ...w.deps, clock: { now: () => new Date('2026-11-13T02:30:00Z') } }, 7, fakeAsk());
    expect(result.kind).toBe('ok');
    expect(w.requests.rows[0]?.request.dueOn).toBe('2026-11-17');
  });
});

describe('#156 o rascunho é do agente', () => { // ADR-002
  it('grava o rascunho como feito pelo agente, no histórico do pedido', async () => { // ADR-002
    const w = world();
    await draftRequest(w.deps, 7, fakeAsk());
    expect(w.requests.created.map((c) => c.by)).toEqual(['agente']);
  });
});
