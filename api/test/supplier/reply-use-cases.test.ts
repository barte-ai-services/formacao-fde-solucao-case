import { describe, expect, it, vi } from 'vitest';
import { NEXT_STEPS, REPLY_OUTCOMES, type RequestFilter } from '../../src/domain/index.js';
import { createReplyUseCases } from '../../src/supplier/reply-use-cases.js';
import {
  ASKS,
  GOOD_FOLLOW_UP,
  NOW,
  PROVIDER_TEXT,
  TODAY,
  fakeMailer,
  noReply,
  parts,
  reading,
  replyRequest,
} from './reply-doubles.js';

// #34: os casos de uso da leitura da resposta (#4): varredura do prazo, envio da cobrança e lista. Nomes de `it` no ADR-004.

describe('#34/AC-3 (#4/AC-2): a varredura do prazo vira no_reply o pedido enviado sem leitura', () => {
  it('marca no_reply com follow_up o pedido sent sem leitura depois do prazo, e monta a cobrança', async () => {
    const { deps, store } = parts([replyRequest(7)]);
    const out = await createReplyUseCases(deps).sweepOverdue();
    expect(out).toEqual({ marked: [7], drafted: [7] });
    expect(store.rows.get(7)?.reading).toMatchObject({ replyOutcome: 'no_reply', nextStep: 'follow_up' });
  });

  it('com um teto, marca só os primeiros atrasados e a chamada seguinte marca o próximo', async () => {
    const { deps, store } = parts([replyRequest(7), replyRequest(8), replyRequest(9)]);
    const useCases = createReplyUseCases(deps);
    expect(await useCases.sweepOverdue(2)).toEqual({ marked: [7, 8], drafted: [7, 8] });
    expect(await useCases.sweepOverdue(2)).toEqual({ marked: [9], drafted: [9] });
    expect(store.calls.map((c) => c.op)).toEqual(['recordReading', 'saveFollowUpDraft', 'recordReading', 'saveFollowUpDraft', 'recordReading', 'saveFollowUpDraft']);
  });

  it('com teto 0 não marca nada', async () => {
    const { deps, store } = parts([replyRequest(7)]);
    expect(await createReplyUseCases(deps).sweepOverdue(0)).toEqual({ marked: [], drafted: [] });
    expect(store.calls).toEqual([]);
  });

  it('no dia do prazo ainda está no prazo, e pedido que não foi enviado fica como está', async () => {
    const { deps, store } = parts([replyRequest(7, { dueOn: TODAY }), replyRequest(8, { status: 'draft' })]);
    expect(await createReplyUseCases(deps).sweepOverdue()).toEqual({ marked: [], drafted: [] });
    expect(store.calls).toEqual([]);
  });

  it('é idempotente: rodar de novo não grava outra vez, e o pedido já lido fica intacto', async () => {
    const read = reading({ replyOutcome: 'refused', nextStep: 'answer_supplier' });
    const { deps, store } = parts([replyRequest(7), replyRequest(8, { reading: read })]);
    const useCases = createReplyUseCases(deps);
    await useCases.sweepOverdue();
    expect(await useCases.sweepOverdue()).toEqual({ marked: [], drafted: [] });
    expect(store.calls.map((c) => c.op)).toEqual(['recordReading', 'saveFollowUpDraft']);
    expect(store.rows.get(8)?.reading).toEqual(read);
  });

  it('não depende do Claude nem envia nada', async () => {
    const { deps, mailer } = parts([replyRequest(7)]);
    await createReplyUseCases(deps).sweepOverdue();
    expect(mailer.sent).toEqual([]);
  });
});

describe('#58/AC-1 (#58/AC-7): a varredura monta a cobrança pela regra, sem o Claude, e nada sai', () => {
  it('#58/AC-1: o pedido atrasado ganha o rascunho da cobrança na mesma varredura que o marca, com o novo prazo de 3 dias úteis', async () => {
    const { deps, store } = parts([replyRequest(7)]);
    await createReplyUseCases(deps).sweepOverdue();
    const { followUp } = store.rows.get(7) ?? replyRequest(0);
    expect(followUp.draft).toMatchObject({ subject: expect.stringContaining('{{nota.numero}}'), body: expect.stringContaining('{{cobranca.prazo}}') });
    expect(followUp.dueOn).toBe('2026-11-25'); // #58/AC-2: hoje é a sexta 2026-11-20
    expect(followUp.sent).toBeNull();
  });

  it('#58/AC-2: a resposta parcial com follow_up, depois do prazo, ganha a cobrança que pede só os itens que o fornecedor não atendeu', async () => {
    const partial = reading({ replyOutcome: 'partially_fulfilled', nextStep: 'follow_up', fulfilledAsks: [ASKS[0] as string] });
    const { deps, store } = parts([replyRequest(7, { reading: partial })]);
    expect(await createReplyUseCases(deps).sweepOverdue()).toEqual({ marked: [], drafted: [7] });
    expect(store.rows.get(7)?.followUp.draft?.asks).toEqual([ASKS[1]]);
    expect(store.rows.get(7)?.followUp.dueOn).toBe('2026-11-25');
    expect(store.calls.map((c) => c.op)).toEqual(['saveFollowUpDraft']); // #58/AC-2: a leitura do fornecedor fica: a varredura não grava outra
    expect(store.rows.get(7)?.reading).toEqual(partial);
  });

  it('#58/AC-2: o pedido de informação com follow_up, depois do prazo, ganha a cobrança com os itens que faltam', async () => {
    const asked = reading({ replyOutcome: 'needs_information', nextStep: 'follow_up' });
    const { deps, store } = parts([replyRequest(7, { reading: asked })]);
    expect(await createReplyUseCases(deps).sweepOverdue()).toEqual({ marked: [], drafted: [7] });
    expect(store.rows.get(7)?.followUp.draft?.asks).toEqual(ASKS);
  });

  it('#58/AC-2: a resposta parcial que ainda está no prazo, ou cujo próximo passo é nosso, não ganha cobrança', async () => {
    const partial = reading({ replyOutcome: 'partially_fulfilled', nextStep: 'follow_up' });
    const ours = reading({ replyOutcome: 'partially_fulfilled', nextStep: 'answer_supplier' });
    const { deps, store } = parts([replyRequest(7, { reading: partial, dueOn: TODAY }), replyRequest(8, { reading: ours })]);
    expect(await createReplyUseCases(deps).sweepOverdue()).toEqual({ marked: [], drafted: [] });
    expect(store.calls).toEqual([]);
  });

  it('#58/AC-2: a cobrança da resposta parcial é montada uma vez só e respeita o teto da rodada', async () => {
    const partial = reading({ replyOutcome: 'partially_fulfilled', nextStep: 'follow_up' });
    const { deps } = parts([replyRequest(7, { reading: partial }), replyRequest(8, { reading: partial })]);
    const useCases = createReplyUseCases(deps);
    expect(await useCases.sweepOverdue(1)).toEqual({ marked: [], drafted: [7] });
    expect(await useCases.sweepOverdue(1)).toEqual({ marked: [], drafted: [8] });
    expect(await useCases.sweepOverdue(1)).toEqual({ marked: [], drafted: [] });
  });

  it('#58/AC-2: o no_reply da varredura não atendeu nada: pede todos os itens do pedido', async () => {
    const { deps, store } = parts([replyRequest(7)]);
    await createReplyUseCases(deps).sweepOverdue();
    expect(store.rows.get(7)?.followUp.draft?.asks).toEqual(ASKS);
  });

  it('#58/AC-1: o pedido já marcado no_reply por uma rodada que caiu antes do rascunho ganha o rascunho na rodada seguinte, e uma só vez', async () => {
    const { deps, store } = parts([replyRequest(7, { reading: noReply() })]);
    const useCases = createReplyUseCases(deps);
    expect(await useCases.sweepOverdue()).toEqual({ marked: [], drafted: [7] });
    expect(await useCases.sweepOverdue()).toEqual({ marked: [], drafted: [] });
    expect(store.calls.map((c) => c.op)).toEqual(['saveFollowUpDraft']);
  });

  it('#58/AC-1: cobrança já enviada não é refeita pela varredura', async () => {
    const stamp = { by: 'ana', at: NOW, channel: 'mock', providerMessageId: 'm' } as const;
    const { deps, store } = parts([replyRequest(7, { reading: noReply(), followUp: { draft: GOOD_FOLLOW_UP, dueOn: null, rejection: null, sent: stamp, failure: null } })]);
    expect(await createReplyUseCases(deps).sweepOverdue()).toEqual({ marked: [], drafted: [] });
    expect(store.calls).toEqual([]);
  });

  it('#58/AC-7: a varredura nunca envia: nenhum e-mail sai, só o rascunho fica gravado', async () => {
    const { deps, mailer, store } = parts([replyRequest(7), replyRequest(8, { reading: noReply() })]);
    await createReplyUseCases(deps).sweepOverdue();
    expect(mailer.sent).toEqual([]);
    expect(store.calls.map((c) => c.op)).not.toContain('claimFollowUpSend');
  });
});

const drafted = () =>
  replyRequest(7, { reading: noReply(), followUp: { draft: GOOD_FOLLOW_UP, dueOn: null, rejection: null, sent: null, failure: null } });

describe('#34/AC-4 (#4/AC-3): a cobrança sai só pelo caso de uso de envio, chamado por uma pessoa', () => {
  it('envia o rascunho renderizado pela porta e grava quem enviou e quando (ADR-005)', async () => {
    const { deps, store, mailer } = parts([drafted()]);
    const out = await createReplyUseCases(deps).sendFollowUp(7, 'ana@jachegou.example');
    expect(out).toMatchObject({ kind: 'ok' });
    expect(mailer.sent).toHaveLength(1);
    const [mail] = mailer.sent;
    expect(mail).toMatchObject({ to: 'compras@bebidas-rio-claro.example', requestType: 'return_note', supplierId: 'F02', attachments: [] });
    expect(mail?.subject).toContain('43894');
    expect(mail?.body).not.toContain('{{');
    expect(store.rows.get(7)?.followUp.sent).toEqual({ by: 'ana@jachegou.example', at: NOW, channel: 'mock', providerMessageId: 'mock-1' });
  });

  it('devolve o pedido como ficou depois do envio: carimbo gravado e sem falha (#34/AC-4)', async () => {
    const failed = replyRequest(7, { ...drafted(), followUp: { ...drafted().followUp, failure: 'mailbox_full' } });
    const { deps } = parts([failed]);
    const out = await createReplyUseCases(deps).sendFollowUp(7, 'ana');
    expect(out.kind === 'ok' && out.request.followUp).toMatchObject({
      sent: { by: 'ana', at: NOW, channel: 'mock', providerMessageId: 'mock-1' },
      failure: null,
    });
  });

  it('reivindica o envio antes de mandar o e-mail (#34/AC-4)', async () => {
    const { deps, store, mailer } = parts([drafted()]);
    await createReplyUseCases(deps).sendFollowUp(7, 'ana');
    expect(store.calls.map((c) => c.op)).toEqual(['claimFollowUpSend', 'recordFollowUpSent']);
    expect(mailer.sent).toHaveLength(1);
  });

  it('a reivindicação e a falha levam quem enviou, para o histórico do pedido (#35)', async () => {
    const { deps, store } = parts([drafted()], [], fakeMailer({ ok: false, reason: 'mailbox_full' }));
    await createReplyUseCases(deps).sendFollowUp(7, 'ana');
    expect(store.calls).toEqual([
      { op: 'claimFollowUpSend', args: [7, 'ana'] },
      { op: 'recordFollowUpFailure', args: [7, 'claim-1', 'mailbox_full', 'ana'] },
    ]);
  });

  it('duas chamadas ao mesmo tempo mandam um e-mail só; a outra volta como conflito (#34/AC-4)', async () => {
    const { deps, mailer } = parts([drafted()]);
    const useCases = createReplyUseCases(deps);
    const results = await Promise.all([useCases.sendFollowUp(7, 'ana'), useCases.sendFollowUp(7, 'bia')]);
    expect(results.map((r) => r.kind).sort()).toEqual(['conflict', 'ok']);
    expect(results).toContainEqual({ kind: 'conflict', reason: 'send_in_progress' });
    expect(mailer.sent).toHaveLength(1);
  });

  it('se a gravação do carimbo falha depois do e-mail, a nova chamada não manda de novo (#34/AC-4)', async () => {
    const { deps, store, mailer } = parts([drafted()]);
    store.failStamp.on = true;
    const useCases = createReplyUseCases(deps);
    await expect(useCases.sendFollowUp(7, 'ana')).rejects.toThrow();
    store.failStamp.on = false;
    expect(await useCases.sendFollowUp(7, 'ana')).toEqual({ kind: 'conflict', reason: 'send_in_progress' });
    expect(mailer.sent).toHaveLength(1);
  });

  it('a falha do envio solta a reivindicação: a pessoa tenta de novo e o e-mail sai (#34/AC-4)', async () => {
    const failing = parts([drafted()], [], fakeMailer({ ok: false, reason: 'mailbox_full' }));
    await createReplyUseCases(failing.deps).sendFollowUp(7, 'ana');
    expect(failing.store.claims.has(7)).toBe(false);
    const retry = createReplyUseCases({ ...failing.deps, mailer: fakeMailer() });
    expect(await retry.sendFollowUp(7, 'ana')).toMatchObject({ kind: 'ok' });
  });

  it('o carimbo leva a ficha da reivindicação que o caso de uso ganhou (#35 REL-3)', async () => {
    const { deps, store } = parts([drafted()]);
    await createReplyUseCases(deps).sendFollowUp(7, 'ana');
    expect(store.calls.at(-1)).toMatchObject({ op: 'recordFollowUpSent', args: [7, 'claim-1', expect.objectContaining({ by: 'ana' })] });
  });

  it('quem perdeu a reivindicação durante o envio e falhou não solta a de outro: volta conflito e nada é gravado (#35 REL-3)', async () => {
    const { deps, store } = parts([drafted()], [], fakeMailer({ ok: false, reason: 'mailbox_full' }));
    const retaken = { send: (m: Parameters<typeof deps.mailer.send>[0]) => { store.claims.set(7, 'claim-de-beto'); return deps.mailer.send(m); } };
    const out = await createReplyUseCases({ ...deps, mailer: retaken }).sendFollowUp(7, 'ana');
    expect(out).toEqual({ kind: 'conflict', reason: 'send_in_progress' });
    expect(store.claims.get(7)).toBe('claim-de-beto');
    expect(store.rows.get(7)?.followUp.failure).toBeNull();
  });

  it('quem perdeu a reivindicação durante o envio e enviou não grava o carimbo: volta conflito e o log leva só campos nomeados (#35 REL-3)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { deps, store } = parts([drafted()]);
      const retaken = { send: (m: Parameters<typeof deps.mailer.send>[0]) => { store.claims.set(7, 'claim-de-beto'); return deps.mailer.send(m); } };
      const out = await createReplyUseCases({ ...deps, mailer: retaken }).sendFollowUp(7, 'ana');
      expect(out).toEqual({ kind: 'conflict', reason: 'send_in_progress' });
      expect(store.rows.get(7)?.followUp.sent).toBeNull();
      expect(store.claims.get(7)).toBe('claim-de-beto');
      expect(log).toHaveBeenCalledWith('#35 a reivindicação da cobrança foi perdida antes de gravar o resultado', {
        operation: 'follow-up-stamp',
        requestId: 7,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain('claim-');
    } finally {
      log.mockRestore();
    }
  });

  it('não envia a cobrança que já saiu', async () => {
    const stamp = { by: 'ana', at: NOW, channel: 'mock', providerMessageId: 'm' } as const;
    const { deps, mailer } = parts([replyRequest(7, { ...drafted(), followUp: { ...drafted().followUp, sent: stamp } })]);
    expect(await createReplyUseCases(deps).sendFollowUp(7, 'bia')).toEqual({ kind: 'conflict', reason: 'already_sent' });
    expect(mailer.sent).toEqual([]);
  });

  it('devolve resultado tipado para pedido inexistente, fora de no_reply e sem rascunho', async () => {
    const { deps, mailer } = parts([
      replyRequest(8),
      replyRequest(9, { reading: noReply() }),
      replyRequest(10, { reading: reading({ replyOutcome: 'refused', nextStep: 'answer_supplier' }) }),
    ]);
    const useCases = createReplyUseCases(deps);
    expect(await useCases.sendFollowUp(1, 'ana')).toEqual({ kind: 'not_found' });
    expect(await useCases.sendFollowUp(8, 'ana')).toEqual({ kind: 'conflict', reason: 'not_follow_up' });
    expect(await useCases.sendFollowUp(10, 'ana')).toEqual({ kind: 'conflict', reason: 'not_follow_up' });
    expect(await useCases.sendFollowUp(9, 'ana')).toEqual({ kind: 'conflict', reason: 'no_draft' });
    expect(mailer.sent).toEqual([]);
  });

  it.each([['partially_fulfilled'], ['needs_information']] as const)('#58/AC-2: envia a cobrança da leitura %s com follow_up, como a do no_reply', async (replyOutcome) => {
    const read = reading({ replyOutcome, nextStep: 'follow_up' });
    const { deps, mailer } = parts([replyRequest(7, { ...drafted(), reading: read })]);
    expect(await createReplyUseCases(deps).sendFollowUp(7, 'ana')).toMatchObject({ kind: 'ok' });
    expect(mailer.sent).toHaveLength(1);
  });

  it('#58/AC-2: a resposta parcial cujo próximo passo é nosso (answer_supplier) não tem cobrança a enviar: conflito not_follow_up', async () => {
    const ours = reading({ replyOutcome: 'partially_fulfilled', nextStep: 'answer_supplier' });
    const { deps, mailer } = parts([replyRequest(7, { ...drafted(), reading: ours })]);
    expect(await createReplyUseCases(deps).sendFollowUp(7, 'ana')).toEqual({ kind: 'conflict', reason: 'not_follow_up' });
    expect(mailer.sent).toEqual([]);
  });

  it('#58/AC-5: a edição que entra entre a leitura do envio e a reivindicação faz o envio recusar (stale), sem mandar o texto antigo', async () => {
    const { deps, store, mailer } = parts([drafted()]);
    const read = store.get;
    store.get = async (id) => {
      const seen = await read(id); // #58/AC-5: o envio leu o texto antigo...
      await store.editFollowUpDraft(id, { ...GOOD_FOLLOW_UP, body: 'Texto novo, até {{cobranca.prazo}}.' }, 'bia'); // #58/AC-5: ...e a edição entrou antes da reivindicação
      return seen;
    };
    expect(await createReplyUseCases(deps).sendFollowUp(7, 'ana')).toEqual({ kind: 'conflict', reason: 'stale' });
    expect(mailer.sent).toEqual([]);
    expect(store.claims.has(7)).toBe(false);
  });

  it('#58/AC-5: depois do stale, repetir o envio manda o texto novo', async () => {
    const { deps, store, mailer } = parts([drafted()]);
    await store.editFollowUpDraft(7, { ...GOOD_FOLLOW_UP, body: 'Texto novo, total {{devolucao.total}}.' }, 'bia');
    expect(await createReplyUseCases(deps).sendFollowUp(7, 'ana')).toMatchObject({ kind: 'ok' });
    expect(mailer.sent[0]?.body).toContain('Texto novo');
  });

  it('revalida o rascunho contra o catálogo: texto com número fora dele não sai', async () => {
    const bad = { ...GOOD_FOLLOW_UP, body: 'Faltam 9999 caixas, total {{devolucao.total}}.' };
    const { deps, mailer } = parts([replyRequest(7, { ...drafted(), followUp: { draft: bad, dueOn: null, rejection: null, sent: null, failure: null } })]);
    expect(await createReplyUseCases(deps).sendFollowUp(7, 'ana')).toEqual({ kind: 'invalid', reason: 'text_invalid' });
    expect(mailer.sent).toEqual([]);
  });

  it('falha do envio grava um motivo curto da própria porta, nunca o texto do provedor', async () => {
    const { deps, store } = parts([drafted()], [], fakeMailer({ ok: false, reason: PROVIDER_TEXT }));
    const out = await createReplyUseCases(deps).sendFollowUp(7, 'ana');
    expect(out).toEqual({ kind: 'send_failed', reason: 'send_failed' });
    expect(store.rows.get(7)?.followUp).toMatchObject({ sent: null, failure: 'send_failed' });
    expect(JSON.stringify([out, store.calls])).not.toContain('smtp');
  });

  it('porta que lança vira falha com motivo próprio, sem o texto do erro', async () => {
    const { deps, store } = parts([drafted()], [], fakeMailer(new Error(PROVIDER_TEXT)));
    const out = await createReplyUseCases(deps).sendFollowUp(7, 'ana');
    expect(out).toEqual({ kind: 'send_failed', reason: 'mailer_error' });
    expect(JSON.stringify([out, store.calls])).not.toContain('sk-segredo');
  });

  it('porta que lança deixa no log do servidor só a classe do erro, a operação e o pedido, nunca o texto', async () => {
    class SmtpDown extends Error {}
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { deps } = parts([drafted()], [], fakeMailer(new SmtpDown(PROVIDER_TEXT)));
      await createReplyUseCases(deps).sendFollowUp(7, 'ana');
      const lines = JSON.stringify(log.mock.calls);
      expect(log).toHaveBeenCalledTimes(1);
      expect(lines).toContain('SmtpDown');
      expect(lines).toContain('follow-up-send');
      expect(lines).not.toContain('smtp 550');
      expect(lines).not.toContain('sk-segredo');
      expect(lines).not.toContain('compras@');
    } finally {
      log.mockRestore();
    }
  });

  it('o motivo curto da porta passa como está; a falha não impede o reenvio', async () => {
    const failing = parts([drafted()], [], fakeMailer({ ok: false, reason: 'mailbox_full' }));
    expect(await createReplyUseCases(failing.deps).sendFollowUp(7, 'ana')).toEqual({ kind: 'send_failed', reason: 'mailbox_full' });
    const retry = createReplyUseCases({ ...failing.deps, mailer: fakeMailer() });
    expect(await retry.sendFollowUp(7, 'ana')).toMatchObject({ kind: 'ok' });
    expect(failing.store.rows.get(7)?.followUp).toMatchObject({ failure: null });
  });
});

const rows = () => [
  replyRequest(1), // #34/AC-5: aguardando: dentro do prazo
  replyRequest(2, { reading: reading({ summary: 'Atendeu.' }) }), // #34/AC-5: atendido
  replyRequest(3, { reading: reading({ replyOutcome: 'needs_information', nextStep: 'answer_supplier' }) }),
  replyRequest(4, { reading: noReply() }),
  replyRequest(5, { dueOn: '2026-11-10' }), // #34/AC-5: enviado sem leitura depois do prazo: atrasado
  replyRequest(6, { status: 'draft' }), // #34/AC-5: não enviado: em nenhum filtro
  replyRequest(7, { reading: reading({ replyOutcome: 'fulfilled', supplierDocument: '881', nextStep: 'confirm_document' }) }),
];
const WITHIN = '2026-11-10';

describe('#34/AC-5: a lista devolve os pedidos de um filtro com a leitura e as contagens de todos', () => {
  it('devolve as contagens de cada filtro e as linhas só do filtro pedido', async () => {
    const { deps } = parts(rows());
    const useCases = createReplyUseCases(deps);
    const answered = await useCases.listRequests('answered', WITHIN);
    expect(answered.counts).toEqual({ awaiting: 2, answered: 1, needs_you: 2, overdue: 1 });
    expect(answered.rows.map((r) => r.id)).toEqual([2]);
    const needs = await useCases.listRequests('needs_you', WITHIN);
    expect(needs.rows.map((r) => r.id)).toEqual([3, 7]);
    expect(needs.counts).toEqual(answered.counts);
  });

  it('o prazo entra pela data de hoje que a chamada traz', async () => {
    const { deps } = parts([replyRequest(5, { dueOn: '2026-11-10' })]);
    const useCases = createReplyUseCases(deps);
    expect((await useCases.listRequests('awaiting', '2026-11-10')).rows.map((r) => r.id)).toEqual([5]);
    expect((await useCases.listRequests('overdue', '2026-11-11')).rows.map((r) => r.id)).toEqual([5]);
  });

  it('cada linha traz o que a lista precisa: pedido, fornecedor, valor, prazo, leitura e a cobrança', async () => {
    const withReading = reading({ replyOutcome: 'refused', nextStep: 'answer_supplier', injectionFlag: null });
    const { deps } = parts([replyRequest(3, { reading: withReading }), drafted()]);
    const [refused] = (await createReplyUseCases(deps).listRequests('needs_you', WITHIN)).rows;
    expect(refused).toEqual({
      id: 3,
      invoiceAccessKey: replyRequest(3).invoiceAccessKey,
      invoiceNumber: '43894',
      supplierId: 'F02',
      supplierName: 'Bebidas Rio Claro',
      requestType: 'return_note',
      totalValue: replyRequest(3).note.total,
      dueOn: '2026-11-17',
      status: 'sent',
      reading: withReading,
      followUpDrafted: false,
      followUpSent: false,
    });
    const [overdue] = (await createReplyUseCases(deps).listRequests('overdue', WITHIN)).rows;
    expect(overdue).toMatchObject({ id: 7, followUpDrafted: true, followUpSent: false });
  });

  it('não grava nada ao listar', async () => {
    const { deps, store } = parts(rows());
    await createReplyUseCases(deps).listRequests('overdue', TODAY);
    expect(store.calls).toEqual([]);
  });
});

describe('#50/AC-3: a lista põe cada pedido enviado em um filtro só', () => {
  const FILTERS: readonly RequestFilter[] = ['awaiting', 'answered', 'needs_you', 'overdue'];

  it('as contagens somam os pedidos enviados e cada pedido aparece nas linhas de um filtro só', async () => {
    let id = 0;
    const sent = [replyRequest((id += 1)), replyRequest((id += 1), { dueOn: '2026-11-10' })];
    for (const replyOutcome of REPLY_OUTCOMES) {
      for (const nextStep of NEXT_STEPS) {
        for (const supplierDocument of [null, '881']) sent.push(replyRequest((id += 1), { reading: reading({ replyOutcome, nextStep, supplierDocument }) }));
      }
    }
    const notSent = [replyRequest((id += 1), { status: 'draft' }), replyRequest((id += 1), { status: 'send_failed' })];
    const { deps } = parts([...sent, ...notSent]);
    const useCases = createReplyUseCases(deps);
    const lists = await Promise.all(FILTERS.map((f) => useCases.listRequests(f, WITHIN)));
    const counts = lists[0]?.counts;
    expect(counts).toBeDefined();
    expect(Object.keys(counts ?? {}).sort()).toEqual([...FILTERS].sort());
    expect(Object.values(counts ?? {}).reduce((a, b) => a + b, 0)).toBe(sent.length);
    const seen = lists.flatMap((l) => l.rows.map((r) => r.id)).sort((a, b) => a - b);
    expect(seen).toEqual(sent.map((r) => r.id));
    for (const l of lists) expect(l.rows).toHaveLength(l.counts[l.filter]);
  });
});

const RULE_DRAFT = {
  subject: 'Cobrança do pedido sobre a nota {{nota.numero}}',
  body: 'Não recebemos a resposta. Responda até {{cobranca.prazo}}.',
  asks: [...ASKS],
};
const ruleDrafted = () =>
  replyRequest(7, { reading: noReply(), followUp: { draft: RULE_DRAFT, dueOn: '2026-11-25', rejection: null, sent: null, failure: null } });

describe('#58/AC-4: editar o texto da cobrança ainda não enviada, revalidado contra o catálogo', () => {
  it('#58/AC-4: troca só o corpo; o assunto, os itens e o novo prazo ficam, e quem editou fica gravado', async () => {
    const { deps, store } = parts([ruleDrafted()]);
    const out = await createReplyUseCases(deps).editFollowUp(7, 'Prezados, respondam até {{cobranca.prazo}} sobre {{devolucao.total}}.', 'ana@jachegou.example');
    expect(out.kind).toBe('ok');
    expect(store.rows.get(7)?.followUp.draft).toEqual({ ...RULE_DRAFT, body: 'Prezados, respondam até {{cobranca.prazo}} sobre {{devolucao.total}}.' });
    expect(store.rows.get(7)?.followUp.dueOn).toBe('2026-11-25');
    expect(store.calls).toEqual([{ op: 'editFollowUpDraft', args: [7, expect.objectContaining({ subject: RULE_DRAFT.subject }), 'ana@jachegou.example'] }]);
  });

  it('#58/AC-4: número solto no texto é recusado (number_mismatch, campo body) e o texto anterior fica', async () => {
    const { deps, store } = parts([ruleDrafted()]);
    const out = await createReplyUseCases(deps).editFollowUp(7, 'Faltam 99 caixas, total {{devolucao.total}}.', 'ana');
    expect(out).toEqual({ kind: 'invalid', reason: 'number_mismatch', field: 'body' });
    expect(store.rows.get(7)?.followUp.draft).toEqual(RULE_DRAFT);
    expect(store.calls).toEqual([]);
  });

  it('#58/AC-4: marcador fora do catálogo é recusado e o texto anterior fica', async () => {
    const { deps, store } = parts([ruleDrafted()]);
    const out = await createReplyUseCases(deps).editFollowUp(7, 'Responda até {{cobranca.prazo_inventado}}.', 'ana');
    expect(out).toEqual({ kind: 'invalid', reason: 'number_mismatch', field: 'body' });
    expect(store.rows.get(7)?.followUp.draft).toEqual(RULE_DRAFT);
  });

  it('#58/AC-4: texto vazio não tem a forma pedida (invalid_shape)', async () => {
    const { deps, store } = parts([ruleDrafted()]);
    expect(await createReplyUseCases(deps).editFollowUp(7, '   ', 'ana')).toEqual({ kind: 'invalid', reason: 'invalid_shape', field: 'body' });
    expect(store.calls).toEqual([]);
  });

  it('#58/AC-5: depois de enviada, a cobrança não se edita (conflict already_sent) e nada é gravado', async () => {
    const stamp = { by: 'ana', at: NOW, channel: 'mock', providerMessageId: 'm' } as const;
    const sent = replyRequest(7, { ...ruleDrafted(), followUp: { ...ruleDrafted().followUp, sent: stamp } });
    const { deps, store } = parts([sent]);
    expect(await createReplyUseCases(deps).editFollowUp(7, 'Novo texto {{cobranca.prazo}}.', 'ana')).toEqual({ kind: 'conflict', reason: 'already_sent' });
    expect(store.calls).toEqual([]);
  });

  it('#58/AC-5: com o envio reivindicado e ainda não carimbado, a edição espera (conflict send_in_progress)', async () => {
    const { deps, store } = parts([ruleDrafted()]);
    store.claims.set(7, 'claim-de-beto');
    expect(await createReplyUseCases(deps).editFollowUp(7, 'Novo texto {{cobranca.prazo}}.', 'ana')).toEqual({ kind: 'conflict', reason: 'send_in_progress' });
    expect(store.rows.get(7)?.followUp.draft).toEqual(RULE_DRAFT);
  });

  it('#58/AC-5: sem rascunho, ou fora de no_reply, ou sem ser enviado, é conflict no_draft; pedido inexistente é not_found', async () => {
    const { deps } = parts([replyRequest(8, { reading: noReply() }), replyRequest(9), { ...ruleDrafted(), id: 10, status: 'draft' as const }]);
    const useCases = createReplyUseCases(deps);
    expect(await useCases.editFollowUp(8, 'Texto.', 'ana')).toEqual({ kind: 'conflict', reason: 'no_draft' });
    expect(await useCases.editFollowUp(9, 'Texto.', 'ana')).toEqual({ kind: 'conflict', reason: 'no_draft' });
    expect(await useCases.editFollowUp(10, 'Texto.', 'ana')).toEqual({ kind: 'conflict', reason: 'no_draft' });
    expect(await useCases.editFollowUp(1, 'Texto.', 'ana')).toEqual({ kind: 'not_found' });
  });

  it('#58/AC-4: a cobrança da resposta parcial com follow_up também se edita; a de leitura que não a pede, não', async () => {
    const partial = reading({ replyOutcome: 'partially_fulfilled', nextStep: 'follow_up' });
    const ours = reading({ replyOutcome: 'partially_fulfilled', nextStep: 'answer_supplier' });
    const { deps } = parts([{ ...ruleDrafted(), reading: partial }, { ...ruleDrafted(), id: 8, reading: ours }]);
    const useCases = createReplyUseCases(deps);
    expect((await useCases.editFollowUp(7, 'Novo texto {{cobranca.prazo}}.', 'ana')).kind).toBe('ok');
    expect(await useCases.editFollowUp(8, 'Novo texto {{cobranca.prazo}}.', 'ana')).toEqual({ kind: 'conflict', reason: 'no_draft' });
  });

  it('#58/AC-7: editar não envia: o e-mail só sai pelo caso de uso de envio, e o texto editado é o que sai, renderizado', async () => {
    const { deps, mailer } = parts([ruleDrafted()]);
    const useCases = createReplyUseCases(deps);
    await useCases.editFollowUp(7, 'Texto editado, responda até {{cobranca.prazo}}.', 'ana');
    expect(mailer.sent).toEqual([]);
    await useCases.sendFollowUp(7, 'ana');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.body).toBe('Texto editado, responda até 25/11/2026.');
    expect(mailer.sent[0]?.dueOn).toBe('2026-11-25');
  });
});
