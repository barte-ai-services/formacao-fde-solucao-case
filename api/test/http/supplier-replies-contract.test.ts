// #36: o teste de contrato da lista de leitura e da visão estendida do pedido ao fornecedor: cada operação que o cabeçalho de
// #36: api/src/http/supplier-requests.ts declara para a leitura da resposta (#4) e a cobrança, com os status, o formato dos corpos,
// #36: os erros genéricos e a prova de que o texto da dependência não sai (#36/AC-2). O contrato é autorado, não gerado (ADR-003).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeMailer } from '../supplier/doubles.js';
import { AFTER_DUE, ASK_OK, READING, listOf, overdueWorld, replyAsk, sentWorld, viewOf, type Json } from '../support/reply-scenarios.js';
import { sweepSupplierOverdue } from '../../src/cron/supplier-sweep.js';
import { supplierWorld } from '../support/supplier-world.js';

afterEach(() => vi.restoreAllMocks());

const READING_SHAPE = {
  replyOutcome: 'fulfilled',
  fulfilledAsks: [ASK_OK],
  supplierDocument: '881',
  summary: READING.summary,
  nextStep: 'confirm_document',
  injectionFlag: null,
};

const ROW_KEYS = ['dueOn', 'followUp', 'id', 'invoiceAccessKey', 'invoiceNumber', 'reading', 'requestType', 'status', 'supplierId', 'supplierName', 'totalCents'];
const VIEW_KEYS_13 = ['asks', 'attachment', 'email', 'invoiceAccessKey', 'requestType', 'returnNote', 'sentAt', 'sentBy', 'status'];

describe('#36/AC-2 GET /api/supplier-requests?status=<filtro de leitura>', () => {
  it('#36/AC-2: responde 200 { filter, requests, counts } com a linha no formato do contrato e as contagens dos quatro filtros', async () => {
    const w = await sentWorld();
    w.receive('Emitimos a NF-D 881 para a devolução.');
    await w.runAllTasks(replyAsk());

    const reply = await w.call('GET', '/api/supplier-requests?status=needs_you');

    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body).sort()).toEqual(['counts', 'filter', 'requests']);
    expect(reply.body.counts).toEqual({ awaiting: 0, answered: 0, needs_you: 1, overdue: 0 });
    const [row] = reply.body.requests as Json[];
    expect(Object.keys(row ?? {}).sort()).toEqual(ROW_KEYS);
    expect(row).toMatchObject({ totalCents: 5943, status: 'sent', reading: READING_SHAPE, followUp: { drafted: false, sent: false } });
    expect(Object.keys(row?.reading).sort()).toEqual(Object.keys(READING_SHAPE).sort());
  });

  it.each(['awaiting', 'answered', 'needs_you', 'overdue'])('#36/AC-2: o filtro %s é aceito e devolve o próprio nome em filter', async (filter) => {
    const w = await sentWorld();
    expect(await w.call('GET', `/api/supplier-requests?status=${filter}`)).toMatchObject({ status: 200, body: { filter } });
  });

  it('#36/AC-2: a linha atrasada traz a leitura no_reply e a cobrança rascunhada; o total é inteiro em centavos', async () => {
    const w = await overdueWorld();
    const { requests, counts } = (await w.call('GET', '/api/supplier-requests?status=overdue')).body as Json;
    expect(counts).toEqual({ awaiting: 0, answered: 0, needs_you: 0, overdue: 1 });
    expect(requests[0]).toMatchObject({ reading: { replyOutcome: 'no_reply', nextStep: 'follow_up', supplierDocument: null, injectionFlag: null }, followUp: { drafted: true, sent: false } });
    expect(Number.isInteger(requests[0].totalCents)).toBe(true);
  });

  it('#36/AC-2: valor fora dos oito (os quatro estados e os quatro filtros) é 400 invalid_status', async () => {
    const w = await sentWorld();
    expect(await w.call('GET', '/api/supplier-requests?status=atrasados')).toMatchObject({ status: 400, body: { error: 'invalid_status' } });
  });

  it('#36/AC-2: a lista dos estados da #13 continua { requests } e o pedido enviado já traz a leitura e a cobrança', async () => {
    const w = await sentWorld();
    const reply = await w.call('GET', '/api/supplier-requests?status=sent');
    expect(Object.keys(reply.body)).toEqual(['requests']);
    expect(((reply.body.requests as Json[])[0] as Json).reading).toBeNull();
  });

  it('#36/AC-2: sem o Access é 401, pelo roteador', async () => {
    const w = await sentWorld();
    expect((await w.call('GET', '/api/supplier-requests?status=overdue', { token: false })).status).toBe(401);
  });

  it('#36/AC-2: a falha do banco é 502 supabase_unavailable com o correlationId, sem o texto da dependência', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await sentWorld();
    w.fake.failNext('outbox_supplier_emails', 'GET', 500, { code: 'XX000', message: 'senha do banco: sb_secret_vazada', hint: 'host interno db.exemplo' });

    const reply = await w.call('GET', '/api/supplier-requests?status=overdue');

    expect(reply.status).toBe(502);
    expect(Object.keys(reply.body).sort()).toEqual(['correlationId', 'error']);
    expect(reply.body.error).toBe('supabase_unavailable');
    expect(JSON.stringify(reply.body)).not.toMatch(/sb_secret|senha|db\.exemplo/);
  });
});

describe('#36/AC-2 GET /api/supplier-requests/{accessKey} estendida com a leitura e a cobrança', () => {
  it('#36/AC-2: o pedido enviado mantém os campos da #13 e ganha reading e followUp; sem resposta, reading é nulo e a cobrança é vazia', async () => {
    const w = await sentWorld();
    const request = await viewOf(w);
    expect(Object.keys(request).sort()).toEqual([...VIEW_KEYS_13, 'documentConfirmation', 'followUp', 'reading'].sort()); // #63/AC-3
    expect(request.reading).toBeNull();
    expect(request.documentConfirmation).toBeNull(); // #63/AC-3
    expect(request.followUp).toEqual({ drafted: false, sent: false, draft: null, dueOn: null, sentBy: null, sentAt: null, failure: null });
    expect(request).toMatchObject({ status: 'sent', sentBy: 'ana@jachegou.test', returnNote: { number: 'ND-1' }, attachment: { name: 'nota-devolucao-ND-1.pdf' } }); // #57/AC-5
  });

  it('#36/AC-2: com a resposta lida, reading traz os seis campos da leitura', async () => {
    const w = await sentWorld();
    w.receive('Emitimos a NF-D 881 para a devolução.');
    await w.runAllTasks(replyAsk());
    expect((await viewOf(w)).reading).toEqual(READING_SHAPE);
  });

  it('#36/AC-2: a cobrança rascunhada vem renderizada e com a forma {{chave}}, para "Cobrar" abrir, revisar e enviar', async () => {
    const w = await overdueWorld();
    const { followUp } = await viewOf(w);
    expect(Object.keys(followUp).sort()).toEqual(['draft', 'drafted', 'dueOn', 'failure', 'sent', 'sentAt', 'sentBy']);
    expect(followUp.dueOn).toBe('2026-11-25'); // #59: o novo prazo da cobrança, AAAA-MM-DD
    expect(Object.keys(followUp.draft).sort()).toEqual(['asks', 'body', 'subject', 'template']);
    expect(followUp.draft.body).toContain('R$ 59,43');
    expect(followUp.draft.body).not.toContain('{{');
    expect(followUp.draft.template).toContain('{{devolucao.total}}');
    expect(followUp.draft.template).toContain('{{cobranca.prazo}}'); // #58/AC-3
  });

  it('#36/AC-2: o rascunho que já não confere com o catálogo vem nulo, e o resto da visão continua', async () => {
    const w = await overdueWorld();
    const row = w.rows('outbox_supplier_emails')[0] as Json;
    row.follow_up_draft = { ...row.follow_up_draft, body: 'Cobramos 99 itens.' };
    const { followUp } = await viewOf(w);
    expect(followUp).toMatchObject({ drafted: true, draft: null });
  });

  it('#36/AC-2: o pedido que ainda é rascunho não traz reading nem followUp', async () => {
    const w = await supplierWorld();
    await w.runCron();
    const request = await viewOf(w);
    expect(request.status).toBe('draft');
    expect(Object.keys(request)).not.toContain('reading');
    expect(Object.keys(request)).not.toContain('followUp');
    expect(Object.keys(request)).not.toContain('documentConfirmation'); // #63/AC-3: só o pedido enviado a traz
  });

  it('#63/AC-3: o contrato da confirmação: POST .../confirm-document responde 200 com a visão sent e documentConfirmation { document, by, at }, só essas chaves', async () => {
    const w = await sentWorld();
    w.receive('Emitimos a NF-D 881 para a devolução.');
    await w.runAllTasks(replyAsk());
    const reply = await w.call('POST', w.path('/confirm-document'), { body: {} });
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body)).toEqual(['request']);
    const { documentConfirmation, status } = reply.body.request as Json;
    expect(status).toBe('sent');
    expect(Object.keys(documentConfirmation).sort()).toEqual(['at', 'by', 'document']);
    expect(documentConfirmation).toEqual({ document: '881', by: 'ana@jachegou.test', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) });
  });

  it('#36/AC-2: a falha do banco na leitura é 502 com o correlationId, sem o texto da dependência', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await sentWorld();
    w.fake.failNext('supplier_reply_readings', 'GET', 500, { message: 'sb_secret_vazada' });
    w.fake.failNext('outbox_supplier_emails', 'GET', 500, { message: 'sb_secret_vazada' });
    const reply = await w.call('GET', w.path());
    expect(reply.status).toBe(502);
    expect(JSON.stringify(reply.body)).not.toContain('sb_secret');
    expect(typeof reply.body.correlationId).toBe('string');
  });
});

describe('#36/AC-3 POST /api/supplier-requests/{accessKey}/send da cobrança', () => {
  it('#36/AC-3: 200 { request } com followUp.sent, quem enviou e quando', async () => {
    const mailer = fakeMailer();
    const w = await overdueWorld({ mailer });
    const reply = await w.call('POST', w.path('/send'), { body: {} });
    expect(reply.status).toBe(200);
    expect((reply.body.request as Json).followUp).toMatchObject({ drafted: true, sent: true, sentBy: 'ana@jachegou.test', sentAt: AFTER_DUE.toISOString(), failure: null });
  });

  it('#36/AC-3: segundo envio é 409 conflict already_sent', async () => {
    const w = await overdueWorld();
    await w.call('POST', w.path('/send'), { body: {} });
    expect((await w.call('POST', w.path('/send'), { body: {} })).body).toEqual({ error: 'conflict', reason: 'already_sent' });
  });

  it('#36/AC-3: no_reply sem rascunho (o rascunho que a varredura não chegou a gravar) é 409 conflict no_draft', async () => {
    const w = await sentWorld();
    w.setNow(AFTER_DUE);
    await sweepSupplierOverdue(w.rest, { now: () => AFTER_DUE });
    (w.rows('outbox_supplier_emails')[0] as Json).follow_up_draft = null;
    expect(await w.call('POST', w.path('/send'), { body: {} })).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'no_draft' } });
  });

  it('#36/AC-3: com a reivindicação de outro envio de pé, 409 conflict send_in_progress e nenhum e-mail', async () => {
    const mailer = fakeMailer();
    const w = await overdueWorld({ mailer });
    const row = w.rows('outbox_supplier_emails')[0] as Json;
    row.follow_up_claimed_at = AFTER_DUE.toISOString();
    row.follow_up_claim = '11111111-1111-4111-8111-111111111111';
    mailer.sent.length = 0;

    const reply = await w.call('POST', w.path('/send'), { body: {} });

    expect(reply).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'send_in_progress' } });
    expect(mailer.sent).toHaveLength(0);
  });

  it('#36/AC-3: o rascunho que já não confere com o catálogo é 422 invalid text_invalid e nada sai', async () => {
    const mailer = fakeMailer();
    const w = await overdueWorld({ mailer });
    const row = w.rows('outbox_supplier_emails')[0] as Json;
    row.follow_up_draft = { ...row.follow_up_draft, body: 'Cobramos 99 itens.' };
    mailer.sent.length = 0;

    expect(await w.call('POST', w.path('/send'), { body: {} })).toMatchObject({ status: 422, body: { error: 'invalid', reason: 'text_invalid' } });
    expect(mailer.sent).toHaveLength(0);
  });

  it('#36/AC-3: a falha do envio é 200 com followUp.failure curto, e o texto do provedor não sai', async () => {
    const mailer = fakeMailer();
    const w = await overdueWorld({ mailer });
    mailer.outcomes.push({ ok: false, reason: 'resend_unavailable' });
    const reply = await w.call('POST', w.path('/send'), { body: {} });
    expect(reply.status).toBe(200);
    expect((reply.body.request as Json).followUp).toMatchObject({ sent: false, failure: 'resend_unavailable' });
  });

  it('#36/AC-3: a falha do envio com o texto do provedor guarda só o motivo próprio da porta', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mailer = fakeMailer();
    const w = await overdueWorld({ mailer });
    mailer.outcomes.push({ ok: false, reason: 'smtp 550: caixa cheia de compras@x.example' });
    const reply = await w.call('POST', w.path('/send'), { body: {} });
    expect((reply.body.request as Json).followUp.failure).toBe('send_failed');
    expect(JSON.stringify(reply.body)).not.toContain('caixa cheia');
  });

  it('#36/AC-3: a falha do banco no envio é 502 com o correlationId, sem o texto da dependência, e nenhum e-mail sai', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mailer = fakeMailer();
    const w = await overdueWorld({ mailer });
    mailer.sent.length = 0;
    w.fake.failNext('outbox_supplier_emails', 'PATCH', 500, { message: 'sb_secret_vazada' });
    const reply = await w.call('POST', w.path('/send'), { body: {} });
    expect(reply.status).toBe(502);
    expect(Object.keys(reply.body).sort()).toEqual(['correlationId', 'error']);
    expect(JSON.stringify(reply.body)).not.toContain('sb_secret');
    expect(mailer.sent).toHaveLength(0);
  });

  it('#36/AC-3: o pedido enviado com resposta lida mantém a recusa da #13, 409 not_draft', async () => {
    const w = await sentWorld();
    w.receive('Emitimos a NF-D 881.');
    await w.runAllTasks(replyAsk());
    expect((await w.call('POST', w.path('/send'), { body: {} })).body).toEqual({ error: 'conflict', reason: 'not_draft' });
  });

  it('#36/AC-3: nota sem pedido é 404, identidade sem e-mail é 403 e corpo sem JSON é 415', async () => {
    const empty = await supplierWorld({ emptyQueue: true });
    expect((await empty.call('POST', empty.path('/send'), { body: {} })).status).toBe(404);
    const service = await supplierWorld({ email: '' });
    expect((await service.call('POST', service.path('/send'), { body: {} })).status).toBe(403);
    expect((await empty.call('POST', empty.path('/send'), { body: {}, json: false })).status).toBe(415);
  });
});

describe('#36/AC-2 a listagem inteira só lê: nenhuma rota de leitura grava', () => {
  it('#36/AC-2: as duas leituras (lista e visão) não fazem nenhuma escrita', async () => {
    const w = await overdueWorld();
    const before = w.fake.requests.length;
    await w.call('GET', '/api/supplier-requests?status=overdue');
    await w.call('GET', w.path());
    expect(w.fake.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([]);
    expect(await listOf(w, 'overdue')).toMatchObject({ filter: 'overdue' });
  });
});
