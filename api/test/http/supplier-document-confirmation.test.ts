// #157: a confirmação do documento citado na leitura da resposta (#157), de ponta a ponta pela API montada sobre o PostgREST falso:
// #157: o Cron lê a resposta (atendeu, com documento), a pessoa confirma pelo POST .../confirm-document, e o pedido vai de
// #157: "precisam de você" para "atendidos". ADR-003 (os testes moram em api/test), ADR-005 (quem e quando).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepSupplierOverdue } from '../../src/cron/supplier-sweep.js';
import { fakeMailer } from '../supplier/doubles.js';
import { AFTER_DUE, ANA, READING, listOf, replyAsk, sentWorld, viewOf, type Json } from '../support/reply-scenarios.js';
import { supplierWorld, type SupplierWorld } from '../support/supplier-world.js';

afterEach(() => vi.restoreAllMocks());

const CONFIRM_AT = new Date('2026-11-13T12:00:00Z');
const OUTBOX = 'outbox_supplier_emails';
const confirm = (w: SupplierWorld, body: unknown = {}) => w.call('POST', w.path('/confirm-document'), { body });

/** #157: o pedido enviado cuja resposta foi lida: atendeu, citou a NF-D 881; o próximo passo é confirm_document. */
async function toConfirm(options: Parameters<typeof sentWorld>[0] = {}): Promise<SupplierWorld> {
  const w = await sentWorld(options);
  w.receive('Emitimos a NF-D 881 para a devolução.');
  await w.runAllTasks(replyAsk());
  w.setNow(CONFIRM_AT);
  return w;
}

/** #157: tudo que não é a caixa de saída do pedido, para provar que a decisão, o título e o valor em risco não mudam. */
const everythingElse = (w: SupplierWorld): string =>
  JSON.stringify([...w.fake.tables.entries()].filter(([table]) => table !== OUTBOX).sort(([a], [b]) => a.localeCompare(b)));

describe('#157 Dado um pedido em confirm_document, quando a pessoa confirma, então fica o documento, quem e quando', () => {
  it('#157: POST .../confirm-document responde 200 com o pedido e a confirmação: o documento da leitura, o e-mail do Access e a hora', async () => {
    const w = await toConfirm();
    expect((await viewOf(w)).reading.nextStep).toBe('confirm_document');

    const reply = await confirm(w);

    expect(reply.status).toBe(200);
    expect((reply.body.request as Json).documentConfirmation).toEqual({ document: '881', by: ANA, at: CONFIRM_AT.toISOString() });
    expect((reply.body.request as Json).status).toBe('sent');
  });

  it('#157: o carimbo vai ao histórico da linha (ADR-005), sem migração: uma entrada document_confirmed com o documento, quem e quando', async () => {
    const w = await toConfirm();
    await confirm(w);
    const history = w.rows(OUTBOX)[0]?.history as Json[];
    expect(history.at(-1)).toMatchObject({ action: 'document_confirmed', by: ANA, at: CONFIRM_AT.toISOString(), document: '881', state: { status: 'sent' } });
  });

  it('#157: o corpo vazio e o corpo {} valem, e quem confirma vem só do Access, nunca do corpo', async () => {
    const w = await toConfirm();
    const reply = await w.call('POST', w.path('/confirm-document'), { body: { by: 'intruso@jachegou.test', document: '999' } });
    expect(reply.status).toBe(200);
    expect((reply.body.request as Json).documentConfirmation).toMatchObject({ document: '881', by: ANA });
    const empty = await toConfirm();
    expect((await empty.call('POST', empty.path('/confirm-document'), { raw: '' })).status).toBe(200);
  });
});

describe('#157 confirmado, o pedido sai de "Precisam de você" e passa a contar em "Atendidos"', () => {
  it('#157: antes, needs_you; depois, answered, e as contagens acompanham', async () => {
    const w = await toConfirm();
    expect((await listOf(w, 'needs_you')).counts).toEqual({ awaiting: 0, answered: 0, needs_you: 1, overdue: 0 });

    await confirm(w);

    expect((await listOf(w, 'needs_you')).requests).toHaveLength(0);
    const answered = await listOf(w, 'answered');
    expect(answered.requests).toHaveLength(1);
    expect(answered.counts).toEqual({ awaiting: 0, answered: 1, needs_you: 0, overdue: 0 });
  });

  it('#157: todo pedido enviado segue em um filtro só, confirmado ou não', async () => {
    const w = await toConfirm();
    for (const step of ['antes', 'depois']) {
      const counts = (await listOf(w, 'answered')).counts as Record<string, number>;
      expect(Object.values(counts).reduce((a, b) => a + b, 0), step).toBe(1);
      await confirm(w);
    }
  });
});

describe('#157 a visão do pedido carrega a confirmação: documento, quem e quando', () => {
  it('#157: GET /api/supplier-requests/{chave} traz documentConfirmation nulo antes e o objeto depois', async () => {
    const w = await toConfirm();
    expect((await viewOf(w)).documentConfirmation).toBeNull();

    await confirm(w);

    expect((await viewOf(w)).documentConfirmation).toEqual({ document: '881', by: ANA, at: CONFIRM_AT.toISOString() });
  });

  it('#157: a lista dos pedidos enviados (status=sent) traz a confirmação na visão de cada um', async () => {
    const w = await toConfirm();
    await confirm(w);
    const { requests } = (await w.call('GET', '/api/supplier-requests?status=sent')).body as Json;
    expect(requests[0].documentConfirmation).toMatchObject({ document: '881', by: ANA });
  });

  it('#157: a visão enviada sem leitura também traz documentConfirmation nulo, nunca ausente', async () => {
    const w = await sentWorld();
    expect(await viewOf(w)).toMatchObject({ status: 'sent', documentConfirmation: null });
  });
});

describe('#157 409 quando o pedido não está em confirm_document ou já foi confirmado; 403 sem identidade', () => {
  it('#157: pedido enviado ainda sem leitura: 409 conflict not_confirm_document', async () => {
    const w = await sentWorld();
    expect(await confirm(w)).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'not_confirm_document' } });
  });

  it('#157: a resposta que recusou ou pediu informação (outro próximo passo): 409 not_confirm_document, e nada é gravado', async () => {
    const w = await sentWorld();
    w.receive('Não podemos aceitar a devolução.');
    await w.runAllTasks(replyAsk({ ...READING, reply_outcome: 'refused', fulfilled_asks: [], supplier_document: null, summary: 'O fornecedor recusou.', next_step: 'answer_supplier' }));
    const before = JSON.stringify(w.rows(OUTBOX));
    expect(await confirm(w)).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'not_confirm_document' } });
    expect(JSON.stringify(w.rows(OUTBOX))).toBe(before);
  });

  it('#157: o pedido atrasado (no_reply) e o que ainda é rascunho: 409 not_confirm_document', async () => {
    const late = await sentWorld();
    late.setNow(AFTER_DUE);
    await sweepSupplierOverdue(late.rest, { now: () => AFTER_DUE });
    expect(await confirm(late)).toMatchObject({ status: 409, body: { reason: 'not_confirm_document' } });

    const draft = await supplierWorld({ emptyQueue: false });
    await draft.runCron();
    expect(await confirm(draft)).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'not_confirm_document' } });
  });

  it('#157: a segunda confirmação do mesmo pedido: 409 already_confirmed, e a primeira (quem e quando) fica', async () => {
    const w = await toConfirm();
    await confirm(w);
    w.setNow(new Date('2026-11-14T08:00:00Z'));

    expect(await confirm(w)).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'already_confirmed' } });

    expect((await viewOf(w)).documentConfirmation).toEqual({ document: '881', by: ANA, at: CONFIRM_AT.toISOString() });
    expect((w.rows(OUTBOX)[0]?.history as Json[]).filter((e) => e.action === 'document_confirmed')).toHaveLength(1);
  });

  it('#157: duas confirmações ao mesmo tempo dão um 200 e um 409', async () => {
    const w = await toConfirm();
    const replies = await Promise.all([confirm(w), confirm(w)]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(replies.find((r) => r.status === 409)?.body).toMatchObject({ error: 'conflict', reason: 'already_confirmed' });
    expect((w.rows(OUTBOX)[0]?.history as Json[]).filter((e) => e.action === 'document_confirmed')).toHaveLength(1);
  });

  it('#157: sem e-mail na identidade do Access (service token) a rota responde 403 forbidden e nada é gravado', async () => {
    const w = await supplierWorld({ email: '', emptyQueue: false });
    await w.runCron();
    expect(await confirm(w)).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(w.fake.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
  });

  it('#157: sem o Access o roteador responde 401', async () => {
    const w = await toConfirm();
    expect((await w.call('POST', w.path('/confirm-document'), { body: {}, token: false })).status).toBe(401);
  });

  it('#157: pedido que não existe é 404 not_found; chave que não tem 44 dígitos é 400 invalid_access_key', async () => {
    const none = await supplierWorld({ emptyQueue: true });
    expect(await confirm(none)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await none.call('POST', none.path('/confirm-document', '123'), { body: {} })).toMatchObject({ status: 400, body: { error: 'invalid_access_key' } });
  });

  it('#157: corpo que não é JSON é 400 invalid_json; sem Content-Type JSON, 415; GET na rota, 405 com Allow: POST', async () => {
    const w = await toConfirm();
    expect(await w.call('POST', w.path('/confirm-document'), { raw: '[1]' })).toMatchObject({ status: 400, body: { error: 'invalid_json' } });
    expect(await w.call('POST', w.path('/confirm-document'), { raw: '{}', json: false })).toMatchObject({ status: 415, body: { error: 'unsupported_media_type' } });
    const get = await w.call('GET', w.path('/confirm-document'));
    expect(get.status).toBe(405);
    expect(get.headers.get('Allow')).toBe('POST');
  });

  it('#157: a falha do Supabase é 502 supabase_unavailable com correlationId, sem o texto da dependência', async () => {
    const w = await toConfirm();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    w.fake.failNext(OUTBOX, 'PATCH', 500, { code: 'XX000', message: 'senha do banco: sb_secret_vazada', hint: 'host interno db.exemplo' });

    const reply = await confirm(w);

    expect(reply).toMatchObject({ status: 502, body: { error: 'supabase_unavailable', correlationId: expect.any(String) } });
    expect(JSON.stringify(reply.body)).not.toMatch(/sb_secret_vazada|db\.exemplo|senha/);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/sb_secret_vazada|db\.exemplo|senha/);
    expect((await viewOf(w)).documentConfirmation).toBeNull();
  });
});

describe('#157 confirmar não muda a decisão, o título nem o valor em risco, e não manda nada ao fornecedor', () => {
  it('#157: nenhuma outra tabela muda, e na caixa de saída só mudam version, history e updated_at', async () => {
    const w = await toConfirm();
    const othersBefore = everythingElse(w);
    const rowBefore = { ...w.rows(OUTBOX)[0] };

    await confirm(w);

    expect(everythingElse(w)).toBe(othersBefore);
    const { version: _v, history: _h, updated_at: _u, ...after } = { ...w.rows(OUTBOX)[0] };
    const { version: _bv, history: _bh, updated_at: _bu, ...before } = rowBefore;
    expect(after).toEqual(before);
  });

  it('#157: a leitura, a nota (o valor), o prazo e a cobrança da visão ficam como estavam', async () => {
    const w = await toConfirm();
    const before = await viewOf(w);

    await confirm(w);

    const { documentConfirmation: _c, ...after } = await viewOf(w);
    const { documentConfirmation: _b, ...was } = before;
    expect(after).toEqual(was);
  });

  it('#157: nada é enviado ao fornecedor: o envio do pedido não é chamado pela confirmação', async () => {
    const mailer = fakeMailer();
    const w = await toConfirm({ mailer });
    mailer.sent.length = 0;
    await confirm(w);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('#157 nenhuma ação automática confirma: só a rota, chamada por uma pessoa', () => {
  it('#157: a leitura, a varredura do prazo e a rodada das tarefas do Cron deixam o pedido sem confirmação', async () => {
    const w = await toConfirm();
    await w.runAllTasks(replyAsk());
    await sweepSupplierOverdue(w.rest, { now: () => AFTER_DUE });
    await w.runAllTasks(replyAsk());

    expect((w.rows(OUTBOX)[0]?.history as Json[]).some((e) => e.action === 'document_confirmed')).toBe(false);
    expect((await viewOf(w)).documentConfirmation).toBeNull();
    expect((await listOf(w, 'needs_you')).requests).toHaveLength(1);
  });

  it('#157: uma segunda resposta que cita o mesmo documento não confirma sozinha, e depois de confirmado mantém a confirmação', async () => {
    const w = await toConfirm();
    w.receive('Reforçamos: a NF-D 881 já foi emitida.');
    await w.runAllTasks(replyAsk({ ...READING, summary: 'O fornecedor reforçou a NF-D 881.' }));
    expect((await viewOf(w)).documentConfirmation).toBeNull();

    await confirm(w);
    w.receive('Só lembrando da NF-D 881.');
    await w.runAllTasks(replyAsk({ ...READING, summary: 'O fornecedor lembrou da NF-D 881.' }));

    expect((await viewOf(w)).documentConfirmation).toMatchObject({ document: '881', by: ANA });
    expect((await listOf(w, 'answered')).requests).toHaveLength(1);
  });

  it('#157: uma leitura nova que cita outro documento volta o pedido a "precisam de você" e pede uma nova confirmação', async () => {
    const w = await toConfirm();
    await confirm(w);
    w.receive('Corrigimos: a nota certa é a NF-D 882.');

    await w.runAllTasks(replyAsk({ ...READING, supplier_document: '882', summary: 'O fornecedor corrigiu para a NF-D 882.' }));

    expect((await viewOf(w)).documentConfirmation).toBeNull();
    expect((await listOf(w, 'needs_you')).requests).toHaveLength(1);
    expect((await listOf(w, 'answered')).requests).toHaveLength(0);
    const again = await confirm(w);
    expect(again.status).toBe(200);
    expect((again.body.request as Json).documentConfirmation).toMatchObject({ document: '882', by: ANA });
  });
});
