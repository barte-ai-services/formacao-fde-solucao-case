// #156: os cenários de aceite do pedido ao fornecedor (#156 a AC-10 e os três cantos da história), de ponta a ponta pela rota
// #156: sobre o PostgREST falso, com o Claude falso e o laço do Cron de verdade. O espelho de api/src/http/supplier-requests.ts (ADR-003).
import { describe, expect, it } from 'vitest';
import { runClaudeRound } from '../../src/claude/cron.js';
import { supabaseReturnNoteQueue } from '../../src/returns/return-notes.js';
import { SOURCE_KEY } from '../domain/supplier-request-fixtures.js';
import { GOOD_TEXT, SUPPLIER_EMAIL, fakeAsk, fakeMailer } from '../supplier/doubles.js';
import { askFailingWith, supplierWorld } from '../support/supplier-world.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- #156 os corpos de resposta são lidos campo a campo

const requestOf = (reply: { body: Record<string, unknown> }): Json => reply.body.request as Json;

describe('#156 Dado uma devolução pendente, quando o Cron roda o agente, então há um rascunho com a nota e o e-mail', () => { // ADR-002
  it('#156: antes do Cron o pedido está sendo escrito; depois, é um rascunho com a nota pela regra e o e-mail do Claude', async () => { // ADR-002
    const w = await supplierWorld();
    expect(requestOf(await w.call('GET', w.path()))).toEqual({ status: 'writing' });

    await w.runCron();

    const request = requestOf(await w.call('GET', w.path()));
    expect(request.status).toBe('draft');
    expect(request.returnNote.lines).toEqual([
      { description: 'Refrigerante cola 2 L', quantity: '7 UN', unitPrice: { text: 'R$ 8,49' }, total: { text: 'R$ 59,43' } },
    ]);
    expect(request.returnNote.total).toEqual({ text: 'R$ 59,43' });
    expect(request.email.body).toContain('R$ 59,43');
    expect(request.email.body).not.toContain('{{');
    expect(request.email.template).toContain('{{devolucao.total}}');
  });

  it('#156: uma nota sem devolução pendente nem pedido não tem pedido', async () => { // ADR-002
    const w = await supplierWorld({ emptyQueue: true });
    expect(requestOf(await w.call('GET', w.path()))).toBeNull();
  });
});

describe('#156 a nota de devolução segue o formato do kit, cita a origem e só leva as linhas devolvidas', () => { // ADR-002
  it('#156: depois do envio, a nota tem as chaves do kit, a nota de origem, só a linha devolvida e o total da fila', async () => { // ADR-002
    const w = await supplierWorld();
    await w.runCron();
    expect((await w.call('POST', w.path('/send'), { body: {} })).status).toBe(200);

    const note = await w.call('GET', w.path('/return-note.json'));

    expect(note.status).toBe(200);
    expect(Object.keys(note.body).sort()).toEqual(
      ['chave', 'data_emissao', 'destino', 'emitente', 'fornecedor_id', 'itens', 'natureza', 'nota_id', 'nota_referenciada', 'numero', 'serie', 'valor_total'].sort(), // ADR-001
    );
    expect(note.body.nota_referenciada).toBe(SOURCE_KEY);
    expect((note.body.itens as Json[]).map((i) => [i.codigo_fornecedor, i.quantidade])).toEqual([['F02-002', 7]]);
    const [emitted] = await supabaseReturnNoteQueue(w.rest).list('emitida', new Date()); // ADR-002
    expect(note.body.valor_total).toBe((emitted?.valueCents ?? 0) / 100);
  });
});

describe('#156 nada é emitido nem enviado sem a pessoa chamar a rota de envio', () => { // ADR-002
  it('#156: com o rascunho pronto, não há nota emitida, e-mail enviado nem fila movida', async () => { // ADR-002
    const mailer = fakeMailer();
    const w = await supplierWorld({ mailer });
    await w.runCron();
    await w.call('GET', w.path());

    expect(w.rows('issued_return_notes')).toHaveLength(0);
    expect(mailer.sent).toHaveLength(0);
    expect(w.rows('outbox_return_notes')[0]?.status).toBe('pendente'); // ADR-002
    expect((await w.call('GET', w.path('/return-note.json'))).status).toBe(404);
  });
});

describe('#156 emitir gera chave e número pelo mock e a fila passa a emitida com o número', () => { // ADR-002
  it('#156: o envio emite a ND-n com a chave de 44 dígitos e a devolução da fila vira emitida com o número', async () => { // ADR-002
    const w = await supplierWorld();
    await w.runCron();

    const sent = await w.call('POST', w.path('/send'), { body: {} });

    expect(sent.status).toBe(200);
    expect(requestOf(sent)).toMatchObject({ status: 'sent', sentBy: 'ana@jachegou.test', returnNote: { number: 'ND-1' }, attachment: { name: 'nota-devolucao-ND-1.pdf' } }); // ADR-002
    const note = await w.call('GET', w.path('/return-note.json'));
    expect(note.body.chave).toMatch(/^\d{44}$/);
    expect(note.body.numero).toBe(1);
    expect(typeof note.body.serie).toBe('number');
    const queue = w.rows('outbox_return_notes')[0];
    expect(queue).toMatchObject({ status: 'emitida', nfe_number: '1', emitted_by: 'ana@jachegou.test' }); // ADR-002
  });
});

describe('#156 emitir de novo a mesma devolução não gera outra nota', () => { // ADR-002
  it('#156: um segundo envio do pedido já enviado é recusado e continua só uma nota emitida', async () => { // ADR-002
    const w = await supplierWorld();
    await w.runCron();
    await w.call('POST', w.path('/send'), { body: {} });

    const again = await w.call('POST', w.path('/send'), { body: {} });

    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'conflict', reason: 'not_draft' });
    expect(w.rows('issued_return_notes')).toHaveLength(1);
  });

  it('#156: o reenvio depois da falha do envio manda o e-mail sem emitir outra nota', async () => { // ADR-002
    const mailer = fakeMailer({ ok: false, reason: 'resend_unavailable' });
    const w = await supplierWorld({ mailer });
    await w.runCron();
    const failed = await w.call('POST', w.path('/send'), { body: {} });
    expect(requestOf(failed)).toMatchObject({ status: 'send_failed', failure: 'resend_unavailable', returnNote: { number: 'ND-1' } }); // ADR-002

    const resent = await w.call('POST', w.path('/resend'), { body: {} });

    expect(resent.status).toBe(200);
    expect(requestOf(resent)).toMatchObject({ status: 'sent', returnNote: { number: 'ND-1' } }); // ADR-002
    expect(w.rows('issued_return_notes')).toHaveLength(1);
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]?.attachments.map((a) => a.filename)).toEqual(['nota-devolucao-ND-1.json', 'nota-devolucao-ND-1.pdf']); // #156
  });
});

describe('#156 o e-mail sai pela caixa de saída mock quando não há chave do Resend', () => { // ADR-002
  it('#156: sem RESEND_API_KEY o pedido fica enviado pelo canal mock, com a nota anexa', async () => { // ADR-002
    const w = await supplierWorld();
    await w.runCron();

    const sent = await w.call('POST', w.path('/send'), { body: {} });

    expect(sent.status).toBe(200);
    const row = w.rows('outbox_supplier_emails')[0];
    expect(row).toMatchObject({ status: 'sent', channel: 'mock' }); // ADR-002
    expect(String(row?.provider_message_id)).toMatch(/^mock-/);
    expect(row?.attachments).toHaveLength(2); // #156
  });
});

describe('#156 número fora do catálogo descarta o rascunho e registra o motivo', () => { // ADR-002
  it('#156: o Claude escreve um número solto e o pedido nasce descartado, com o motivo, sem nota nem e-mail', async () => { // ADR-002
    const w = await supplierWorld();
    await w.runCron(fakeAsk({ ...GOOD_TEXT, body: 'Devolvemos 99 itens, no valor de {{devolucao.total}}.' }));

    const reply = await w.call('GET', w.path());

    expect(requestOf(reply)).toEqual({ status: 'failed', failure: 'number_mismatch' });
    expect(w.rows('outbox_supplier_emails')[0]?.discard_reason).toBe('number_mismatch: body');
    expect(w.rows('issued_return_notes')).toHaveLength(0);
    expect((await w.call('POST', w.path('/send'), { body: {} })).body).toEqual({ error: 'conflict', reason: 'not_draft' });
  });
});

describe('#156 a pessoa edita o texto do e-mail, mas não os números, os itens nem o que pedimos', () => { // ADR-002
  it('#156: o PATCH troca só o corpo; assunto, itens, total e lista do que pedimos ficam como estavam', async () => { // ADR-002
    const w = await supplierWorld();
    await w.runCron();
    const before = requestOf(await w.call('GET', w.path()));
    const template = 'Bom dia. Devolvemos {{devolucao.item[F02-002].quantidade}} de F02-002; total {{devolucao.total}}.';

    const patched = await w.call('PATCH', w.path(), { body: { template, subject: 'outro', asks: ['outro'], items: [] } });

    expect(patched.status).toBe(200);
    const after = requestOf(patched);
    expect(after.email.template).toBe(template);
    expect(after.email.body).toBe('Bom dia. Devolvemos 7 UN de F02-002; total R$ 59,43.');
    expect(after.email.subject).toBe(before.email.subject);
    expect(after.asks).toEqual(before.asks);
    expect(after.returnNote).toEqual(before.returnNote);
  });

  it('#156: um texto com número solto é recusado com 422 e o corpo anterior fica', async () => { // ADR-002
    const w = await supplierWorld();
    await w.runCron();
    const before = requestOf(await w.call('GET', w.path()));

    const refused = await w.call('PATCH', w.path(), { body: { template: 'Devolvemos 8 caixas, total {{devolucao.total}}.' } });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ error: 'invalid', reason: 'number_mismatch', field: 'body' });
    expect(requestOf(await w.call('GET', w.path())).email.template).toBe(before.email.template);
  });
});

describe('#156 uma nota de origem não tem dois pedidos abertos do mesmo tipo', () => { // ADR-002
  it('#156: o Cron rodando duas vezes cria um pedido só, e refazer com um aberto dá 409', async () => { // ADR-002
    const w = await supplierWorld({ ask: fakeAsk() });
    await w.runCron();
    await w.runCron();
    expect(w.rows('outbox_supplier_emails')).toHaveLength(1);

    const redo = await w.call('POST', w.path('/redo'), { body: {} });

    expect(redo.status).toBe(409);
    expect(redo.body).toEqual({ error: 'conflict', reason: 'open_request_exists' });
    expect(w.rows('outbox_supplier_emails')).toHaveLength(1);
  });

  it('#156: descartado o rascunho, refazer abre um novo e só ele fica aberto', async () => { // ADR-002
    const w = await supplierWorld({ ask: fakeAsk() });
    await w.runCron();
    const discarded = await w.call('POST', w.path('/discard'), { body: { reason: '  texto ruim  ' } });
    expect(requestOf(discarded)).toMatchObject({ status: 'discarded', discardedBy: 'ana@jachegou.test' }); // ADR-002

    const redo = await w.call('POST', w.path('/redo'), { body: {} });

    expect(redo.status).toBe(200);
    expect(requestOf(redo).status).toBe('draft'); // ADR-002
    const open = w.rows('outbox_supplier_emails').filter((r) => r.status !== 'discarded'); // ADR-002
    expect(open).toHaveLength(1);
    expect(w.rows('outbox_supplier_emails')[0]?.discard_reason).toBe('texto ruim');
  });
});

describe('#156 o pedido vai para o e-mail de teste do fornecedor', () => { // ADR-002
  it('#156: o rascunho e o e-mail enviado têm o e-mail do fornecedor como destino', async () => { // ADR-002
    const mailer = fakeMailer();
    const w = await supplierWorld({ mailer });
    await w.runCron();
    expect(requestOf(await w.call('GET', w.path())).email.to).toBe(SUPPLIER_EMAIL);

    await w.call('POST', w.path('/send'), { body: {} });

    expect(mailer.sent[0]?.to).toBe(SUPPLIER_EMAIL);
    expect(w.rows('outbox_supplier_emails')[0]?.recipient).toBe(SUPPLIER_EMAIL);
  });
});

describe('#156 canto: sem credencial do Claude, ou com 401 ou 429, nenhum rascunho é criado e nada quebra', () => { // ADR-002
  it('#156: sem credencial a rodada do Claude pula as tarefas e o pedido segue sendo escrito', async () => { // ADR-002
    const w = await supplierWorld();

    const round = await runClaudeRound(w.rest, {}, { log: () => undefined });

    expect(round.ran).toBe(false);
    expect(requestOf(await w.call('GET', w.path()))).toEqual({ status: 'writing' });
    expect(w.rows('outbox_supplier_emails')).toHaveLength(0);
  });

  it.each([401, 429])('#156: com %i do Claude nenhum rascunho é criado e a leitura continua respondendo', async (status) => { // ADR-002
    const w = await supplierWorld();

    const log = await w.runCron(askFailingWith(status));

    expect(w.rows('outbox_supplier_emails')).toHaveLength(0);
    expect(log.join('\n')).not.toContain('chave-de-teste');
    expect(requestOf(await w.call('GET', w.path()))).toEqual({ status: 'writing' });
  });
});

describe('#156 o e-mail do envio leva o JSON e o PDF da nota (cenário da história)', () => { // ADR-002
  it('#156: Dado um rascunho com nota, quando a pessoa envia, então a caixa de saída mock leva dois anexos e o GET do PDF o devolve', async () => { // ADR-002
    const w = await supplierWorld();
    await w.runCron();
    expect((await w.call('POST', w.path('/send'), { body: {} })).status).toBe(200);

    const [email] = w.rows('outbox_supplier_emails');
    expect(email?.channel).toBe('mock');
    const attachments = email?.attachments as Json[];
    expect(attachments.map((a) => a.filename)).toEqual(['nota-devolucao-ND-1.json', 'nota-devolucao-ND-1.pdf']);
    const pdf = await w.download(w.path('/return-note.pdf'));
    expect([pdf.status, pdf.headers.get('content-type')]).toEqual([200, 'application/pdf']);
  });

  it('#156: o PDF devolvido traz o que o JSON da nota traz', async () => { // ADR-002
    const w = await supplierWorld();
    await w.runCron();
    await w.call('POST', w.path('/send'), { body: {} });
    const note = (await w.call('GET', w.path('/return-note.json'))).body as Json;
    const pdf = (await w.download(w.path('/return-note.pdf'))).text;
    expect(pdf).toContain(note.chave);
    expect(pdf).toContain(note.nota_referenciada);
    expect(pdf).toContain(note.nota_id);
    expect(pdf).toContain('R$ 59,43');
  });

  it('#156: depois da emissão, o anexo da visão aponta para o PDF; antes, não há anexo', async () => { // ADR-002
    const w = await supplierWorld();
    await w.runCron();
    expect(requestOf(await w.call('GET', w.path())).attachment).toBeUndefined();
    await w.call('POST', w.path('/send'), { body: {} });
    expect(requestOf(await w.call('GET', w.path())).attachment).toEqual({ name: 'nota-devolucao-ND-1.pdf', url: w.path('/return-note.pdf') });
  });

  it('#156: o reenvio depois da falha anexa o mesmo PDF e continua uma só nota emitida', async () => { // ADR-002
    const mailer = fakeMailer({ ok: false, reason: 'resend_unavailable' });
    const w = await supplierWorld({ mailer });
    await w.runCron();
    await w.call('POST', w.path('/send'), { body: {} });
    expect((await w.call('POST', w.path('/resend'), { body: {} })).status).toBe(200);

    const pdfs = mailer.sent.map((m) => m.attachments.find((a) => a.contentType === 'application/pdf')?.content);
    expect(pdfs).toHaveLength(2);
    expect(pdfs[1]).toBe(pdfs[0]);
    expect(pdfs[0]).toBe((await w.download(w.path('/return-note.pdf'))).text);
    expect(w.rows('issued_return_notes')).toHaveLength(1);
  });
});
