// #58: a cobrança montada pela regra e editável antes de enviar, de ponta a ponta pela API montada sobre o PostgREST falso:
// #58: a varredura do prazo do Cron monta o rascunho (sem o Claude), o PATCH .../follow-up troca o texto, o POST .../send envia (ADR-003).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tasksFor } from '../../src/claude/tasks/index.js';
import { sweepSupplierOverdue } from '../../src/cron/supplier-sweep.js';
import { fakeMailer } from '../supplier/doubles.js';
import { LEASE_MS } from '../../src/supplier/supabase-store.js';
import { AFTER_DUE, ANA, ASK_OK, READING, replyAsk, sentWorld, viewOf, type Json } from '../support/reply-scenarios.js';
import { supplierWorld, type SupplierWorld } from '../support/supplier-world.js';

afterEach(() => vi.restoreAllMocks());

/** #58: o pedido enviado que passou do prazo, varrido pelo Cron: só a regra montou a cobrança. */
async function overdue(options: Parameters<typeof sentWorld>[0] = {}): Promise<SupplierWorld> {
  const w = await sentWorld(options);
  w.setNow(AFTER_DUE);
  await sweepSupplierOverdue(w.rest, { now: () => AFTER_DUE });
  return w;
}

const PATCH = (w: SupplierWorld) => w.path('/follow-up');
const edit = (w: SupplierWorld, template: unknown) => w.call('PATCH', PATCH(w), { body: { template } });
const draftOf = async (w: SupplierWorld): Promise<Json> => ((await viewOf(w)).followUp as Json).draft as Json;
const EDITED = 'Prezados, ainda sem resposta sobre a nota {{nota.numero}}. Respondam até {{cobranca.prazo}}, por favor.';

describe('#58/AC-1 a cobrança é montada pela regra na varredura do prazo, sem o Claude', () => {
  it('#58/AC-1: o Cron varre o prazo e o pedido ganha o rascunho da cobrança, sem nenhuma pergunta ao Claude', async () => {
    const w = await sentWorld();
    w.setNow(AFTER_DUE);

    expect((await sweepSupplierOverdue(w.rest, { now: () => AFTER_DUE })).marked).toBe(1);
    const ask = replyAsk();
    await w.runAllTasks(ask);

    expect((await viewOf(w)).followUp).toMatchObject({ drafted: true, sent: false, sentBy: null, sentAt: null, failure: null });
    expect(ask.calls).toBe(0);
  });

  it('#58/AC-1: a tarefa supplier-follow-up-draft saiu do Cron: tasksFor não a registra', async () => {
    const w = await supplierWorld();
    expect(tasksFor(w.rest).map((t) => t.name)).not.toContain('supplier-follow-up-draft');
  });

  it('#58/AC-1: a varredura monta o rascunho mesmo sem credencial do Claude, e a rodada seguinte não o refaz', async () => {
    const w = await overdue();
    const before = w.rows('outbox_supplier_emails')[0]?.follow_up_draft;

    await sweepSupplierOverdue(w.rest, { now: () => AFTER_DUE });

    expect(before).not.toBeNull();
    expect(w.rows('outbox_supplier_emails')[0]?.follow_up_draft).toEqual(before);
  });

  it('#58/AC-1: o rascunho gravado leva o carimbo da regra no histórico (ADR-005), e não o de uma pessoa', async () => {
    const w = await overdue();
    const history = w.rows('outbox_supplier_emails')[0]?.history as { by: string; action: string }[];
    expect(history.at(-1)).toMatchObject({ action: 'follow_up_drafted', by: 'supplier-overdue-sweep' });
  });
});

describe('#58/AC-2 e #58/AC-3 a cobrança pede só o que falta, cita a nota e traz o novo prazo, com todo número como marcador', () => {
  it('#58/AC-2: o rascunho renderizado cita a nota de origem e o novo prazo de 3 dias úteis (sexta 20/11 vira quarta 25/11)', async () => {
    const w = await overdue();
    const draft = await draftOf(w);
    expect(draft.subject).toContain('43894');
    expect(draft.body).toContain('43894');
    expect(draft.body).toContain('25/11/2026');
    expect(draft.body).not.toContain('{{');
  });

  it('#58/AC-2: pede os itens do pedido que a leitura não deu por atendidos (sem leitura de resposta, todos)', async () => {
    const w = await overdue();
    expect((await draftOf(w)).asks).toEqual(['Confirmar o recebimento da nota de devolução', 'Creditar R$ 59,43 até 17/11/2026']);
  });

  it('#58/AC-3: o texto guardado (template) traz o novo prazo e a nota só como {{chave}}, e nenhum algarismo fora de um marcador', async () => {
    const w = await overdue();
    const draft = await draftOf(w);
    expect(draft.template).toContain('{{cobranca.prazo}}');
    expect(draft.template).toContain('{{nota.numero}}');
    expect(String(draft.template).replace(/\{\{[^}]*\}\}/g, '')).not.toMatch(/\d/);
    expect(String(draft.subject)).toContain('43894');
  });
});

describe('#58/AC-4 PATCH /api/supplier-requests/{chave}/follow-up troca só o texto da cobrança ainda não enviada', () => {
  it('#58/AC-4: 200 { request } com a cobrança no texto novo; o assunto e os itens ficam, e o novo prazo é o do catálogo', async () => {
    const w = await overdue();
    const before = await draftOf(w);

    const reply = await edit(w, EDITED);

    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body)).toEqual(['request']);
    const request = reply.body.request as Json;
    expect(request).toMatchObject({ status: 'sent', followUp: { drafted: true, sent: false, failure: null } });
    expect(request.followUp.draft).toEqual({
      subject: before.subject,
      body: 'Prezados, ainda sem resposta sobre a nota 43894. Respondam até 25/11/2026, por favor.',
      template: EDITED,
      asks: before.asks,
    });
  });

  it('#58/AC-4: o texto editado fica gravado e revalidado a cada leitura; o histórico guarda o e-mail do Access como quem editou', async () => {
    const w = await overdue();
    await edit(w, EDITED);

    expect((await draftOf(w)).template).toBe(EDITED);
    const row = w.rows('outbox_supplier_emails')[0] ?? {};
    expect((row.follow_up_draft as Json).body).toBe(EDITED);
    expect((row.history as { by: string; action: string }[]).at(-1)).toMatchObject({ action: 'follow_up_edited', by: ANA });
  });

  it('#58/AC-4: o corpo do pedido não decide quem edita: um `by` no corpo é ignorado', async () => {
    const w = await overdue();
    await w.call('PATCH', PATCH(w), { body: { template: EDITED, by: 'outro@jachegou.test' } });
    expect((w.rows('outbox_supplier_emails')[0]?.history as { by: string }[]).at(-1)?.by).toBe(ANA);
  });

  it('#58/AC-4: um número solto dá 422 invalid number_mismatch no campo body, e o texto anterior fica', async () => {
    const w = await overdue();
    const before = await draftOf(w);

    const reply = await edit(w, 'Faltam 99 caixas, respondam até {{cobranca.prazo}}.');

    expect(reply).toMatchObject({ status: 422, body: { error: 'invalid', reason: 'number_mismatch', field: 'body' } });
    expect(await draftOf(w)).toEqual(before);
  });

  it('#58/AC-4: um marcador fora do catálogo dá 422 number_mismatch, e o texto anterior fica', async () => {
    const w = await overdue();
    const before = await draftOf(w);

    const reply = await edit(w, 'Respondam até {{cobranca.prazo_inventado}}.');

    expect(reply).toMatchObject({ status: 422, body: { error: 'invalid', reason: 'number_mismatch', field: 'body' } });
    expect(await draftOf(w)).toEqual(before);
  });

  it.each([[undefined], [''], ['   '], [42], [['a']]])('#58/AC-4: o template %j que não é um texto dá 422 invalid_shape, e o texto anterior fica', async (template) => {
    const w = await overdue();
    const before = await draftOf(w);

    expect(await edit(w, template)).toMatchObject({ status: 422, body: { error: 'invalid', reason: 'invalid_shape', field: 'body' } });
    expect(await draftOf(w)).toEqual(before);
  });

  it('#58/AC-4: sem o Access é 401; sem e-mail na identidade, 403; escrita sem JSON, 415; chave que não tem 44 dígitos, 400', async () => {
    const w = await overdue();
    expect((await w.call('PATCH', PATCH(w), { body: { template: EDITED }, token: false })).status).toBe(401);
    expect((await w.call('PATCH', w.path('/follow-up', '123'), { body: { template: EDITED } }))).toMatchObject({ status: 400, body: { error: 'invalid_access_key' } });
    expect((await w.call('PATCH', PATCH(w), { body: { template: EDITED }, json: false }))).toMatchObject({ status: 415, body: { error: 'unsupported_media_type' } });
    expect((await w.call('PATCH', PATCH(w), { raw: '[1]' }))).toMatchObject({ status: 400, body: { error: 'invalid_json' } });
    const noEmail = await supplierWorld({ email: '' });
    expect((await noEmail.call('PATCH', PATCH(noEmail), { body: { template: EDITED } })).status).toBe(403);
    expect((await draftOf(w)).template).not.toBe(EDITED);
  });

  it('#58/AC-4: a rota só aceita PATCH (405 com Allow), e o pedido que não existe é 404', async () => {
    const w = await overdue();
    const get = await w.call('GET', PATCH(w));
    expect(get).toMatchObject({ status: 405, body: { error: 'method_not_allowed' } });
    expect(get.headers.get('Allow')).toBe('PATCH');
    expect((await w.call('POST', PATCH(w), { body: {} })).status).toBe(405);
    const none = await supplierWorld({ emptyQueue: true });
    expect(await edit(none, EDITED)).toMatchObject({ status: 404, body: { error: 'not_found' } });
  });

  it('#58/AC-4: o pedido enviado ainda sem leitura (sem rascunho de cobrança) é 409 conflict no_draft', async () => {
    const w = await sentWorld();
    expect(await edit(w, EDITED)).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'no_draft' } });
  });

  it('#58/AC-4: a falha do banco é 502 supabase_unavailable com o correlationId, sem o texto da dependência', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await overdue();
    w.fake.failNext('outbox_supplier_emails', 'PATCH', 500, { code: 'XX000', message: 'senha do banco: sb_secret_vazada', hint: 'host interno db.exemplo' });

    const reply = await edit(w, EDITED);

    expect(reply.status).toBe(502);
    expect(Object.keys(reply.body).sort()).toEqual(['correlationId', 'error']);
    expect(JSON.stringify(reply.body)).not.toContain('sb_secret_vazada');
    expect(JSON.stringify(reply.body)).not.toContain('db.exemplo');
  });
});

describe('#58/AC-5 depois de enviada, a cobrança não é editável', () => {
  it('#58/AC-5: o PATCH depois do envio é 409 conflict already_sent, e o texto enviado fica como saiu', async () => {
    const mailer = fakeMailer();
    const w = await overdue({ mailer });
    mailer.sent.length = 0;
    await edit(w, EDITED);
    expect((await w.call('POST', w.path('/send'), { body: {} })).status).toBe(200);
    const sentText = await draftOf(w);

    const reply = await edit(w, 'Outro texto, respondam até {{cobranca.prazo}}.');

    expect(reply).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'already_sent' } });
    expect(await draftOf(w)).toEqual(sentText);
    expect(mailer.sent).toHaveLength(1);
  });

  it('#58/AC-5: com o envio reivindicado e sem carimbo, o PATCH é 409 send_in_progress e não troca o texto', async () => {
    const w = await overdue();
    const row = w.rows('outbox_supplier_emails')[0] ?? {};
    row.follow_up_claimed_at = AFTER_DUE.toISOString();
    row.follow_up_claim = '11111111-1111-4111-8111-111111111111';
    const before = await draftOf(w);

    expect(await edit(w, EDITED)).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'send_in_progress' } });
    expect(await draftOf(w)).toEqual(before);
  });
});

describe('#58/AC-7 nada sai sem uma pessoa: a cobrança só é enviada pela rota de envio', () => {
  it('#58/AC-7: nem a varredura nem a edição enviam; a pessoa envia pela rota de envio e sai o texto editado, renderizado', async () => {
    const mailer = fakeMailer();
    const w = await overdue({ mailer });
    mailer.sent.length = 0;
    await w.runAllTasks(replyAsk());
    expect((await edit(w, EDITED)).status).toBe(200);
    expect(mailer.sent).toHaveLength(0);

    const sent = await w.call('POST', w.path('/send'), { body: {} });

    expect(sent.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ body: 'Prezados, ainda sem resposta sobre a nota 43894. Respondam até 25/11/2026, por favor.', dueOn: '2026-11-25' });
    expect((sent.body.request as Json).followUp).toMatchObject({ sent: true, sentBy: ANA });
  });

  it('#58/AC-7: o PATCH não tem efeito de envio: só o rascunho muda e o estado do envio fica intacto', async () => {
    const mailer = fakeMailer();
    const w = await overdue({ mailer });
    mailer.sent.length = 0;
    await edit(w, EDITED);
    const row = w.rows('outbox_supplier_emails')[0] ?? {};
    expect(mailer.sent).toHaveLength(0);
    expect([row.follow_up_sent_at, row.follow_up_sent_by, row.follow_up_claimed_at, row.follow_up_provider_message_id]).toEqual([null, null, null, null]);
  });
});

/** #58/AC-2 (ref-pr40): a resposta que o domínio produz e ainda pede cobrança: o fornecedor atendeu um item e o próximo passo é follow_up. */
const PARTIAL = { ...READING, reply_outcome: 'partially_fulfilled', supplier_document: null, summary: 'O fornecedor atendeu só parte do pedido.', next_step: 'follow_up' };

/** #58/AC-2: o pedido que o fornecedor respondeu pela metade (lido antes do prazo); o relógio fica no dia da leitura. */
async function answeredHalf(options: Parameters<typeof sentWorld>[0] = {}, reading: Record<string, unknown> = PARTIAL): Promise<SupplierWorld> {
  const w = await sentWorld(options);
  w.receive('Creditamos a nota de devolução; falta o comprovante.');
  await w.runAllTasks(replyAsk(reading));
  return w;
}

const sweepAt = async (w: SupplierWorld, now: Date): Promise<void> => {
  w.setNow(now);
  await sweepSupplierOverdue(w.rest, { now: () => now });
};

describe('#58/AC-2 a resposta parcial com follow_up, passado o prazo, também ganha a cobrança, e a pessoa a envia', () => {
  it('#58/AC-2: a varredura monta a cobrança só com o item que o fornecedor não atendeu, com o novo prazo, e a leitura dele fica', async () => {
    const w = await answeredHalf();
    await sweepAt(w, AFTER_DUE);
    const view = await viewOf(w);
    expect(view.reading).toMatchObject({ replyOutcome: 'partially_fulfilled', nextStep: 'follow_up' });
    expect((view.followUp as Json).draft.asks).toEqual(['Creditar R$ 59,43 até 17/11/2026']);
    expect((view.followUp as Json).draft.body).toContain('25/11/2026');
    expect(w.rows('outbox_supplier_emails')[0]).toMatchObject({ follow_up_draft: { dueOn: '2026-11-25' } });
    expect(w.rows('outbox_supplier_emails')[0]?.history).toContainEqual(expect.objectContaining({ action: 'follow_up_drafted', by: 'supplier-overdue-sweep' }));
  });

  it('#58/AC-2: antes do prazo a resposta parcial não ganha cobrança', async () => {
    const w = await answeredHalf();
    await sweepAt(w, new Date('2026-11-17T15:00:00Z')); // #58/AC-2: o dia do prazo ainda está no prazo
    expect(((await viewOf(w)).followUp as Json).draft).toBeNull();
  });

  it('#58/AC-2: a resposta parcial cujo próximo passo é nosso (answer_supplier) não ganha cobrança', async () => {
    const w = await answeredHalf({}, { ...PARTIAL, next_step: 'answer_supplier' });
    await sweepAt(w, AFTER_DUE);
    expect(((await viewOf(w)).followUp as Json).draft).toBeNull();
  });

  it('#58/AC-2: a rota de envio aceita a resposta parcial: edita (PATCH), envia (POST) e o texto editado sai; depois, 409 already_sent', async () => {
    const mailer = fakeMailer();
    const w = await answeredHalf({ mailer });
    await sweepAt(w, AFTER_DUE);
    expect((await edit(w, EDITED)).status).toBe(200);

    const sent = await w.call('POST', w.path('/send'), { body: {} });

    expect(sent.status).toBe(200);
    expect(mailer.sent.at(-1)).toMatchObject({ body: 'Prezados, ainda sem resposta sobre a nota 43894. Respondam até 25/11/2026, por favor.' });
    expect((sent.body.request as Json).followUp).toMatchObject({ sent: true, sentBy: ANA });
    expect(await w.call('POST', w.path('/send'), { body: {} })).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'already_sent' } });
  });

  it('#58/AC-2: a leitura que não pede cobrança (recusa) não tem o que enviar nem editar: 409, e nada sai', async () => {
    const mailer = fakeMailer();
    const w = await answeredHalf({ mailer }, { ...READING, reply_outcome: 'refused', supplier_document: null, summary: 'O fornecedor recusou.', next_step: 'answer_supplier', fulfilled_asks: [] });
    await sweepAt(w, AFTER_DUE);
    const before = mailer.sent.length;
    expect((await w.call('POST', w.path('/send'), { body: {} })).status).toBe(409);
    expect(await edit(w, EDITED)).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'no_draft' } });
    expect(mailer.sent).toHaveLength(before);
  });
});

describe('#58/AC-5 a reivindicação vencida não trava a edição', () => {
  it('#58/AC-5: com o envio reivindicado há mais que o prazo (LEASE_MS) e sem carimbo, o PATCH é 200 e troca o texto', async () => {
    const w = await overdue();
    const row = w.rows('outbox_supplier_emails')[0] ?? {};
    row.follow_up_claimed_at = new Date(AFTER_DUE.getTime() - LEASE_MS - 1000).toISOString();
    row.follow_up_claim = '11111111-1111-4111-8111-111111111111';

    expect((await edit(w, EDITED)).status).toBe(200);

    expect((await draftOf(w)).template).toBe(EDITED);
    expect(row).toMatchObject({ follow_up_claimed_at: null, follow_up_claim: null });
  });
});

describe('#59 a visão do pedido enviado traz o novo prazo da cobrança em followUp.dueOn', () => {
  it('#59: o pedido com a cobrança montada traz dueOn AAAA-MM-DD (o novo prazo); sem cobrança, null', async () => {
    const w = await sentWorld();
    expect(((await viewOf(w)).followUp as Json).dueOn).toBeNull();
    await sweepAt(w, AFTER_DUE);
    expect(((await viewOf(w)).followUp as Json).dueOn).toBe('2026-11-25');
  });
});
