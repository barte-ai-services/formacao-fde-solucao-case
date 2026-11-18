// #13: o teste de contrato do pedido ao fornecedor: cada operação do cabeçalho de api/src/http/supplier-requests.ts (#13/AC-3),
// #13: com os status e o formato dos corpos, os erros genéricos e a prova de que o texto da dependência não sai (#13/AC-2).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeError } from '../../src/claude/client.js';
import { SOURCE_KEY } from '../domain/supplier-request-fixtures.js';
import { fakeAsk, fakeMailer } from '../supplier/doubles.js';
import { supplierWorld, type SupplierWorld } from '../support/supplier-world.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- #13 os corpos de resposta são lidos campo a campo

afterEach(() => vi.restoreAllMocks());

const drafted = async (options: Parameters<typeof supplierWorld>[0] = {}): Promise<SupplierWorld> => {
  const w = await supplierWorld(options);
  await w.runCron();
  return w;
};

const DRAFT_SHAPE = {
  status: 'draft', // ADR-002
  invoiceAccessKey: SOURCE_KEY,
  requestType: 'return_note',
  returnNote: {
    number: null,
    supplier: 'F02',
    reference: '43894',
    lines: [{ description: 'Refrigerante cola 2 L', quantity: '7 UN', unitPrice: { text: 'R$ 8,49' }, total: { text: 'R$ 59,43' } }],
    total: { text: 'R$ 59,43' },
  },
  email: { to: expect.any(String), dueOn: '2026-11-17', subject: 'Devolução da nota 43894', body: expect.any(String), template: expect.any(String) },
  asks: ['Confirmar o recebimento da nota de devolução', 'Creditar R$ 59,43 até 17/11/2026'],
};

describe('#13/AC-3 GET /api/supplier-requests/{accessKey}', () => { // ADR-002
  it('#13/AC-3: sem pedido nem devolução pendente responde 200 com request nulo', async () => {  // ADR-002
    const w = await supplierWorld({ emptyQueue: true });
    expect(await w.call('GET', w.path())).toMatchObject({ status: 200, body: { request: null } });
  });

  it('#13/AC-3: com a devolução pendente e sem rascunho responde writing', async () => { // ADR-002
    const w = await supplierWorld();
    expect(await w.call('GET', w.path())).toMatchObject({ status: 200, body: { request: { status: 'writing' } } });
  });

  it('#13/AC-3: o rascunho tem o formato da visão, com a nota sem número e sem anexo antes da emissão', async () => { // ADR-002
    const w = await drafted();
    const reply = await w.call('GET', w.path());
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ request: DRAFT_SHAPE });
    expect(Object.keys(reply.body.request as object)).not.toContain('attachment');
  });

  it('#13/AC-3: enviado, a visão ganha o anexo, o número ND-n, quem enviou e quando', async () => { // ADR-002
    const w = await drafted();
    await w.call('POST', w.path('/send'), { body: {} });
    const { request } = (await w.call('GET', w.path())).body as Json;
    expect(request).toMatchObject({
      status: 'sent', // ADR-002
      sentBy: 'ana@jachegou.test',
      sentAt: '2026-11-12T15:00:00.000Z',
      returnNote: { number: 'ND-1' },
      // #57/AC-5: o anexo da visão é o PDF da nota (a gaveta mostra o link dele); o JSON segue em return-note.json
      attachment: { name: 'nota-devolucao-ND-1.pdf', url: `/api/supplier-requests/${SOURCE_KEY}/return-note.pdf` },
    });
  });

  it('#13/AC-3: descartado por uma pessoa, a visão traz quando e quem', async () => { // ADR-002
    const w = await drafted();
    await w.call('POST', w.path('/discard'), { body: {} });
    expect((await w.call('GET', w.path())).body).toEqual({
      request: { status: 'discarded', discardedAt: '2026-11-12T15:00:00.000Z', discardedBy: 'ana@jachegou.test' }, // ADR-002
    });
  });

  it('#13/AC-3: o pedido que o agente descartou aparece como failed, com o motivo curto', async () => { // ADR-002
    const w = await supplierWorld();
    await w.runCron(fakeAsk({ subject: 'x', body: 'y', asks: [] }));
    expect((await w.call('GET', w.path())).body).toEqual({ request: { status: 'failed', failure: 'invalid_shape' } });
  });

  it('#13/AC-3: chave que não tem 44 dígitos responde 400 invalid_access_key', async () => { // ADR-002
    const w = await supplierWorld();
    expect(await w.call('GET', '/api/supplier-requests/123')).toMatchObject({ status: 400, body: { error: 'invalid_access_key' } });
  });
});

describe('#13/AC-3 PATCH /api/supplier-requests/{accessKey}', () => { // ADR-002
  it('#13/AC-3: troca o corpo e responde 200 com o pedido', async () => { // ADR-002
    const w = await drafted();
    const reply = await w.call('PATCH', w.path(), { body: { template: 'Total {{devolucao.total}}.' } });
    expect(reply).toMatchObject({ status: 200, body: { request: { status: 'draft', email: { body: 'Total R$ 59,43.', template: 'Total {{devolucao.total}}.' } } } }); // ADR-002
  });

  it('#13/AC-3: número solto é 422 invalid com o motivo e o campo', async () => { // ADR-002
    const w = await drafted();
    expect((await w.call('PATCH', w.path(), { body: { template: 'Pague 10 reais.' } })).body).toEqual({ error: 'invalid', reason: 'number_mismatch', field: 'body' });
  });

  it.each([{}, { template: 7 }, { template: '   ' }])('#13/AC-3: corpo %j sem texto é 422 invalid_shape', async (body) => { // ADR-002
    const w = await drafted();
    expect((await w.call('PATCH', w.path(), { body })).body).toEqual({ error: 'invalid', reason: 'invalid_shape', field: 'body' });
  });

  it('#13/AC-3: depois do envio o corpo já não muda: 409 not_draft', async () => { // ADR-002
    const w = await drafted();
    await w.call('POST', w.path('/send'), { body: {} });
    expect(await w.call('PATCH', w.path(), { body: { template: 'Total {{devolucao.total}}.' } })).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'not_draft' } });
  });

  it('#13/AC-3: nota sem pedido é 404 not_found', async () => { // ADR-002
    const w = await supplierWorld({ emptyQueue: true });
    expect(await w.call('PATCH', w.path(), { body: { template: 'x' } })).toMatchObject({ status: 404, body: { error: 'not_found' } });
  });
});

describe('#13/AC-3 POST /api/supplier-requests/{accessKey}/send e /resend', () => { // ADR-002
  it('#13/AC-3: o envio de um rascunho é 200 e o pedido volta enviado', async () => { // ADR-002
    const w = await drafted();
    expect(await w.call('POST', w.path('/send'), { body: {} })).toMatchObject({ status: 200, body: { request: { status: 'sent' } } }); // ADR-002
  });

  it('#13/AC-3: a falha do envio é um estado, com 200 e o código curto, nunca o texto do provedor', async () => { // ADR-002
    const w = await drafted({ mailer: fakeMailer(new Error('SMTP: senha do servidor errada')) });
    const reply = await w.call('POST', w.path('/send'), { body: {} });
    expect(reply.status).toBe(200);
    expect((reply.body.request as Json).failure).toBe('mailer_error');
    expect(JSON.stringify(reply.body)).not.toContain('senha');
  });

  it('#13/AC-3: reenviar de um enviado é 409 not_send_failed e enviar de um send_failed é 409 not_draft', async () => { // ADR-002
    const w = await drafted({ mailer: fakeMailer({ ok: false, reason: 'resend_unavailable' }) });
    expect((await w.call('POST', w.path('/resend'), { body: {} })).body).toEqual({ error: 'conflict', reason: 'not_send_failed' });
    await w.call('POST', w.path('/send'), { body: {} });
    expect((await w.call('POST', w.path('/send'), { body: {} })).body).toEqual({ error: 'conflict', reason: 'not_draft' });
  });

  it('#13/AC-3: o reenvio de um send_failed é 200 e volta enviado', async () => { // ADR-002
    const w = await drafted({ mailer: fakeMailer({ ok: false, reason: 'resend_unavailable' }) });
    await w.call('POST', w.path('/send'), { body: {} });
    expect(await w.call('POST', w.path('/resend'), { body: {} })).toMatchObject({ status: 200, body: { request: { status: 'sent' } } }); // ADR-002
  });

  it('#13/AC-3: com a devolução já tratada na fila o envio é 409 queue_not_pending', async () => { // ADR-002
    const w = await drafted();
    w.rows('outbox_return_notes')[0]!.status = 'cancelada'; // ADR-002
    expect((await w.call('POST', w.path('/send'), { body: {} })).body).toEqual({ error: 'conflict', reason: 'queue_not_pending' });
  });

  it('#13/AC-3: sem pedido o envio é 404', async () => { // ADR-002
    const w = await supplierWorld({ emptyQueue: true });
    expect((await w.call('POST', w.path('/send'), { body: {} })).status).toBe(404);
  });
});

describe('#13/AC-3 POST /api/supplier-requests/{accessKey}/discard', () => { // ADR-002
  it('#13/AC-3: sem motivo grava discarded_by_user; o motivo é aparado e cortado em 500', async () => { // ADR-002
    const w = await drafted();
    await w.call('POST', w.path('/discard'), { body: {} });
    expect(w.rows('outbox_supplier_emails')[0]?.discard_reason).toBe('discarded_by_user');

    const second = await drafted();
    await second.call('POST', second.path('/discard'), { body: { reason: `  ${'a'.repeat(600)}  ` } });
    expect(second.rows('outbox_supplier_emails')[0]?.discard_reason).toBe('a'.repeat(500));
  });

  it('#13/AC-3: motivo que não é texto é 422; descartar um enviado é 409 not_draft', async () => { // ADR-002
    const w = await drafted();
    expect((await w.call('POST', w.path('/discard'), { body: { reason: 5 } })).body).toEqual({ error: 'invalid', reason: 'invalid_shape', field: 'reason' });
    await w.call('POST', w.path('/send'), { body: {} });
    expect((await w.call('POST', w.path('/discard'), { body: {} })).body).toEqual({ error: 'conflict', reason: 'not_draft' });
  });
});

describe('#13/AC-3 POST /api/supplier-requests/{accessKey}/redo', () => { // ADR-002
  it('#13/AC-3: com o último descartado e sem aberto, refaz o rascunho pelo Claude e responde 200', async () => { // ADR-002
    const w = await drafted({ ask: fakeAsk() });
    await w.call('POST', w.path('/discard'), { body: {} });
    expect(await w.call('POST', w.path('/redo'), { body: {} })).toMatchObject({ status: 200, body: { request: { status: 'draft' } } }); // ADR-002
  });

  it('#13/AC-3: com a devolução já tratada na fila, refazer é 409 queue_not_pending', async () => { // ADR-002
    const w = await drafted({ ask: fakeAsk() });
    await w.call('POST', w.path('/discard'), { body: {} });
    w.rows('outbox_return_notes')[0]!.status = 'cancelada'; // ADR-002
    expect((await w.call('POST', w.path('/redo'), { body: {} })).body).toEqual({ error: 'conflict', reason: 'queue_not_pending' });
  });

  it('#13/AC-3: sem credencial do Claude é 503 claude_unavailable, e o pedido descartado fica', async () => { // ADR-002
    const w = await drafted();
    await w.call('POST', w.path('/discard'), { body: {} });
    expect(await w.call('POST', w.path('/redo'), { body: {} })).toMatchObject({ status: 503, body: { error: 'claude_unavailable' } });
  });

  it.each(['auth', 'rate_limit'] as const)('#13/AC-3: %s do Claude é 503 claude_unavailable, sem o texto dele', async (kind) => { // ADR-002
    const ask = fakeAsk(new ClaudeError(kind, 'HTTP 401 chave-secreta-do-claude'));
    const w = await drafted({ ask });
    await w.call('POST', w.path('/discard'), { body: {} });
    const reply = await w.call('POST', w.path('/redo'), { body: {} });
    expect(reply).toMatchObject({ status: 503, body: { error: 'claude_unavailable' } });
    expect(JSON.stringify(reply.body)).not.toContain('chave-secreta');
  });

  it('#13/AC-3: outra falha do Claude é 502 claude_unavailable com o correlationId e o texto só no log, em campos', async () => { // ADR-002
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await drafted({ ask: fakeAsk(new ClaudeError('network', 'falha de rede em api.interna.example')) });
    await w.call('POST', w.path('/discard'), { body: {} });
    const reply = await w.call('POST', w.path('/redo'), { body: {} });
    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'claude_unavailable', correlationId: expect.any(String) });
    expect(JSON.stringify(log.mock.calls)).not.toContain('api.interna');
    expect(log.mock.calls[0]?.[1]).toMatchObject({ operation: 'redo', kind: 'network', correlationId: reply.body.correlationId });
  });

  it('#13/AC-3: sem pedido é 404', async () => { // ADR-002
    const w = await supplierWorld({ emptyQueue: true, ask: fakeAsk() });
    expect((await w.call('POST', w.path('/redo'), { body: {} })).status).toBe(404);
  });
});

describe('#13/AC-3 GET /api/supplier-requests/{accessKey}/return-note.json', () => { // ADR-002
  it('#13/AC-3: antes da emissão é 404; depois, a nota no formato do kit', async () => { // ADR-002
    const w = await drafted();
    expect(await w.call('GET', w.path('/return-note.json'))).toMatchObject({ status: 404, body: { error: 'not_found' } });
    await w.call('POST', w.path('/send'), { body: {} });
    expect(await w.call('GET', w.path('/return-note.json'))).toMatchObject({
      status: 200,
      body: { nota_id: 'ND-1', numero: 1, natureza: 'devolucao', nota_referenciada: SOURCE_KEY, valor_total: 59.43 }, // ADR-001 ADR-002
    });
  });
});

describe('#57/AC-2 GET /api/supplier-requests/{accessKey}/return-note.pdf', () => { // ADR-002
  it('#57/AC-2: antes da emissão é 404 not_found; depois, 200 application/pdf com o PDF da nota', async () => { // ADR-002
    const w = await drafted();
    expect(await w.call('GET', w.path('/return-note.pdf'))).toMatchObject({ status: 404, body: { error: 'not_found' } });
    await w.call('POST', w.path('/send'), { body: {} });
    const pdf = await w.download(w.path('/return-note.pdf'));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.text.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.text).toContain('ND-1');
  });

  it('#57/AC-2: a chave que não tem 44 dígitos é 400 invalid_access_key', async () => { // ADR-002
    const w = await supplierWorld();
    expect(await w.call('GET', '/api/supplier-requests/123/return-note.pdf')).toMatchObject({ status: 400, body: { error: 'invalid_access_key' } });
  });
});

describe('#13/AC-3 GET /api/supplier-requests?status=', () => { // ADR-002
  it('#13/AC-3: lista os pedidos do estado, padrão draft', async () => { // ADR-002
    const w = await drafted();
    const byDefault = await w.call('GET', '/api/supplier-requests');
    expect(byDefault.body).toEqual({ requests: [DRAFT_SHAPE] });
    expect(((await w.call('GET', '/api/supplier-requests?status=sent')).body as Json).requests).toEqual([]);
    await w.call('POST', w.path('/send'), { body: {} });
    const sent = (await w.call('GET', '/api/supplier-requests?status=sent')).body as Json;
    expect(sent.requests).toHaveLength(1);
    expect(sent.requests[0].status).toBe('sent'); // ADR-002
  });

  it('#13/AC-3: o pedido sem a nota de origem sai da lista e o motivo vai ao log, só em campos', async () => { // ADR-002
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await drafted();
    w.rows('invoices').length = 0; // #13: a nota de origem some; a visão do rascunho não se monta
    const reply = await w.call('GET', '/api/supplier-requests');
    expect(reply.body).toEqual({ requests: [] });
    expect(log.mock.calls).toHaveLength(1);
    expect(log.mock.calls[0]?.[1]).toEqual({ operation: 'supplier_requests.list', dropped: 'source_missing', invoiceAccessKey: SOURCE_KEY });
  });

  it('#13/AC-3: estado fora dos quatro é 400 invalid_status', async () => { // ADR-002
    const w = await supplierWorld();
    expect(await w.call('GET', '/api/supplier-requests?status=pendente')).toMatchObject({ status: 400, body: { error: 'invalid_status' } });
  });
});

describe('#13/AC-2 as rotas exigem o Access e, nas escritas, JSON; o erro é genérico', () => { // ADR-002
  it('#13/AC-2: sem o token do Access é 401, em qualquer rota', async () => { // ADR-002
    const w = await supplierWorld();
    expect((await w.call('GET', w.path(), { token: false })).status).toBe(401);
    expect((await w.call('POST', w.path('/send'), { token: false, body: {} })).status).toBe(401);
  });

  it('#13/AC-2: identidade sem e-mail não escreve: 403 forbidden, e lê', async () => { // ADR-002
    const w = await drafted({ email: '' });
    expect(await w.call('POST', w.path('/send'), { body: {} })).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect((await w.call('GET', w.path())).status).toBe(200);
  });

  it('#13/AC-2: escrita sem Content-Type JSON é 415 e corpo que não é um objeto JSON é 400 invalid_json', async () => { // ADR-002
    const w = await drafted();
    expect(await w.call('POST', w.path('/send'), { json: false, body: {} })).toMatchObject({ status: 415, body: { error: 'unsupported_media_type' } });
    expect(await w.call('PATCH', w.path(), { raw: '[1]' })).toMatchObject({ status: 400, body: { error: 'invalid_json' } });
    expect(await w.call('PATCH', w.path(), { raw: '{nao-json' })).toMatchObject({ status: 400, body: { error: 'invalid_json' } });
  });

  it('#13/AC-2: método fora do contrato é 405 com Allow', async () => { // ADR-002
    const w = await supplierWorld();
    const cases: [string, string, string][] = [
      ['DELETE', w.path(), 'GET, PATCH'],
      ['GET', w.path('/send'), 'POST'],
      ['POST', w.path('/return-note.json'), 'GET'],
      ['POST', w.path('/return-note.pdf'), 'GET'],
      ['POST', '/api/supplier-requests', 'GET'],
    ];
    for (const [method, path, allow] of cases) {
      const reply = await w.call(method, path, { body: {} });
      expect([reply.status, reply.headers.get('allow'), reply.body]).toEqual([405, allow, { error: 'method_not_allowed' }]);
    }
  });

  it('#13/AC-2: quem age vem do Access, nunca do corpo', async () => { // ADR-002
    const w = await drafted();
    await w.call('POST', w.path('/send'), { body: { by: 'intruso@x.test', sent_by: 'intruso@x.test' } });
    expect(w.rows('outbox_supplier_emails')[0]?.sent_by).toBe('ana@jachegou.test');
  });

  it('#13/AC-2: Worker sem as credenciais do Supabase é 503 supabase_not_configured', async () => { // ADR-002
    const w = await supplierWorld({ supabase: 'missing' });
    expect(await w.call('GET', w.path())).toMatchObject({ status: 503, body: { error: 'supabase_not_configured' } });
    expect((await w.call('GET', '/api/supplier-requests')).status).toBe(503);
  });

  it('#13/AC-2: falha do banco é 502 com o correlationId; o texto dele só vai ao log, em campos nomeados', async () => { // ADR-002
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await supplierWorld();
    w.fake.failNext('outbox_supplier_emails', 'GET', 500, { message: 'senha-do-banco postgres://interno' });

    const reply = await w.call('GET', w.path());

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'supabase_unavailable', correlationId: expect.any(String) });
    expect(JSON.stringify(reply.body)).not.toContain('senha-do-banco');
    expect(JSON.stringify(log.mock.calls)).not.toContain('senha-do-banco');
    expect(log.mock.calls[0]?.[1]).toMatchObject({ operation: 'get', table: 'outbox_supplier_emails', status: 500, correlationId: reply.body.correlationId });
  });

  it('#13/AC-2: falha inesperada é 500 internal_error com o correlationId, sem o texto do erro', async () => { // ADR-002
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await drafted({ ask: fakeAsk(new Error('segredo-interno do modelo')) });
    await w.call('POST', w.path('/discard'), { body: {} });

    const reply = await w.call('POST', w.path('/redo'), { body: {} });

    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ error: 'internal_error', correlationId: expect.any(String) });
    expect(JSON.stringify(log.mock.calls)).not.toContain('segredo-interno');
  });

  it('#13/AC-2: o texto do Claude recusado nunca chega ao corpo da resposta', async () => { // ADR-002
    const w = await supplierWorld();
    await w.runCron(fakeAsk({ subject: 'Pague 99999 agora, texto-do-modelo', body: 'x', asks: ['y'] }));
    const reply = await w.call('GET', w.path());
    expect(JSON.stringify(reply.body)).not.toContain('texto-do-modelo');
  });
});
