import { describe, expect, it } from 'vitest';
import { ClaudeError } from '../../src/claude/client.js';
import { supplierRequestDraftTask } from '../../src/supplier/draft-task.js';
import { createSupplierUseCases } from '../../src/supplier/use-cases.js';
import { GOOD_TEXT, NOW, draftInput, SUPPLIER_EMAIL, fakeAsk, fakeMailer, statusOf, world, type FakeMailer, type World } from './doubles.js';

const BY = 'ana@jachegou.example';

const drafted = async (mailer: FakeMailer = fakeMailer()): Promise<World> => {
  const w = world(mailer);
  await supplierRequestDraftTask(w.deps).run(draftInput(), fakeAsk());
  return w;
};

describe('#11/AC-4 emitir e enviar', () => { // ADR-002
  it('emite a nota pelo mock, move a fila para emitida com o número e envia com a nota anexa', async () => { // ADR-002
    const w = await drafted();
    const result = await createSupplierUseCases(w.deps).send(41, BY);
    expect(result.kind).toBe('ok');
    expect(w.notes.issuedCount).toBe(1);
    expect(w.queue.emitCalls).toEqual([[7, '101', BY, NOW]]);
    expect(w.queue.views[0]).toMatchObject({ status: 'emitida', emitted: { number: '101', by: BY } });
    expect(statusOf(w, 41)).toBe('sent');
    expect(w.requests.rows[0]?.request.issuedNote?.number).toBe(101);
  });

  it('o e-mail vai para o fornecedor, com os números do catálogo no lugar dos marcadores', async () => { // ADR-002
    const w = await drafted();
    await createSupplierUseCases(w.deps).send(41, BY);
    const [mail] = w.mailer.sent;
    expect(mail?.to).toBe(SUPPLIER_EMAIL);
    expect(mail?.requestType).toBe('return_note');
    expect(mail?.invoiceAccessKey).toBe(w.requests.rows[0]?.request.invoiceAccessKey);
    expect(mail?.subject).toContain('43894');
    expect(mail?.body).not.toContain('{{');
    expect(mail?.body).toContain('7 UN');
    expect(mail?.asks.join(' ')).not.toContain('{{');
    expect(mail?.dueOn).toBe('2026-11-17');
  });

  it('grava quem enviou, quando, o canal e o identificador do provedor', async () => { // ADR-002
    const w = await drafted(fakeMailer({ ok: true, channel: 'resend', providerMessageId: 'msg-9' }));
    await createSupplierUseCases(w.deps).send(41, BY);
    expect(w.requests.rows[0]?.stamps).toContainEqual({
      by: BY,
      at: NOW,
      action: 'sent',
      claim: 'claim-1',
      sent: {
        channel: 'resend',
        providerMessageId: 'msg-9',
        attachments: [
          { filename: 'nota-devolucao-ND-101.json', contentType: 'application/json', issuedReturnNoteId: 101 },
          { filename: 'nota-devolucao-ND-101.pdf', contentType: 'application/pdf', issuedReturnNoteId: 101 },
        ],
      },
    });
  });

  it('#57/AC-1: o e-mail leva dois anexos, o JSON e o PDF da nota', async () => { // ADR-002
    const w = await drafted();
    await createSupplierUseCases(w.deps).send(41, BY);
    const attachments = w.mailer.sent[0]?.attachments ?? [];
    expect(attachments.map((a) => [a.filename, a.contentType])).toEqual([
      ['nota-devolucao-ND-101.json', 'application/json'],
      ['nota-devolucao-ND-101.pdf', 'application/pdf'],
    ]);
    expect(attachments[1]?.content.startsWith('%PDF-1.4')).toBe(true);
  });

  it('pedido que não existe é not_found, sem emitir nada', async () => { // ADR-002
    const w = await drafted();
    expect(await createSupplierUseCases(w.deps).send(99, BY)).toEqual({ kind: 'not_found' });
    expect(w.notes.issuedCount).toBe(0);
  });

  it('pedido já enviado ou descartado é conflito, sem outro e-mail', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    await useCases.send(41, BY);
    expect(await useCases.send(41, BY)).toEqual({ kind: 'conflict', reason: 'not_sendable' });
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('devolução que já não está pendente na fila é conflito: nada é emitido nem registrado e o e-mail não sai', async () => { // ADR-002
    const w = await drafted();
    w.queue.views[0]!.status = 'emitida';
    w.queue.views[0]!.emitted = { number: '999', by: 'outra@jachegou.example', at: NOW.toISOString() };
    expect(await createSupplierUseCases(w.deps).send(41, BY)).toEqual({ kind: 'conflict', reason: 'queue_not_pending' });
    expect(w.mailer.sent).toEqual([]);
    expect(statusOf(w, 41)).toBe('draft');
    expect(w.notes.issuedCount).toBe(0);
    expect(w.requests.rows[0]?.request.issuedNote).toBeNull();
    expect(w.queue.emitCalls).toEqual([]);
  });

  it('devolução emitida com o número deste pedido é um reenvio: não emite outra nota nem move a fila de novo', async () => { // ADR-002
    const w = await drafted(fakeMailer({ ok: false, reason: 'caixa_de_saida_indisponivel' }));
    const useCases = createSupplierUseCases(w.deps);
    await useCases.send(41, BY);
    expect(w.queue.views[0]).toMatchObject({ status: 'emitida', emitted: { number: '101' } });
    expect((await useCases.send(41, BY)).kind).toBe('ok');
    expect(w.notes.issuedCount).toBe(1);
    expect(w.queue.emitCalls).toHaveLength(1);
  });

  it('devolução que sumiu da fila é conflito', async () => { // ADR-002
    const w = await drafted();
    w.queue.views.length = 0;
    expect(await createSupplierUseCases(w.deps).send(41, BY)).toEqual({ kind: 'conflict', reason: 'queue_entry_missing' });
  });

  it('nota de origem que o cadastro não devolve é invalid, antes de emitir', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases({ ...w.deps, source: { find: async () => null } });
    expect(await useCases.send(41, BY)).toEqual({ kind: 'invalid', reason: 'source_missing' });
    expect(w.notes.issuedCount).toBe(0);
  });
});

describe('#11/AC-5 reenviar nunca emite outra nota', () => { // ADR-002
  it('a falha do envio deixa send_failed com o motivo; o reenvio usa a nota emitida e envia', async () => { // ADR-002
    const w = await drafted(fakeMailer({ ok: false, reason: 'caixa_de_saida_indisponivel' }));
    const useCases = createSupplierUseCases(w.deps);
    expect(await useCases.send(41, BY)).toMatchObject({ kind: 'send_failed', reason: 'caixa_de_saida_indisponivel' });
    expect(statusOf(w, 41)).toBe('send_failed');
    expect(w.requests.rows[0]?.request.sendFailureReason).toBe('caixa_de_saida_indisponivel');
    expect(w.queue.views[0]?.status).toBe('emitida');

    expect((await useCases.send(41, BY)).kind).toBe('ok');
    expect(w.notes.issuedCount).toBe(1);
    expect(statusOf(w, 41)).toBe('sent');
    expect(w.queue.views[0]?.emitted?.number).toBe('101');
    expect(w.mailer.sent).toHaveLength(2);
    expect(w.mailer.sent[1]?.attachments[0]?.filename).toBe('nota-devolucao-ND-101.json');
  });

  it('#57/AC-6: o reenvio anexa o mesmo PDF da primeira tentativa, sem emitir outra nota', async () => { // ADR-002
    const w = await drafted(fakeMailer({ ok: false, reason: 'caixa_de_saida_indisponivel' }));
    const useCases = createSupplierUseCases(w.deps);
    await useCases.send(41, BY);
    expect((await useCases.send(41, BY)).kind).toBe('ok');
    const [first, second] = w.mailer.sent.map((m) => m.attachments.find((a) => a.contentType === 'application/pdf'));
    expect(first?.filename).toBe('nota-devolucao-ND-101.pdf');
    expect(second).toEqual(first);
    expect(w.notes.issuedCount).toBe(1);
  });

  it('o reenvio que falha de novo troca o motivo e continua send_failed', async () => { // ADR-002
    const w = await drafted(fakeMailer({ ok: false, reason: 'primeira' }, { ok: false, reason: 'segunda' }));
    const useCases = createSupplierUseCases(w.deps);
    await useCases.send(41, BY);
    await useCases.send(41, BY);
    expect(w.requests.rows[0]?.request.sendFailureReason).toBe('segunda');
    expect(w.notes.issuedCount).toBe(1);
  });

  it('o envio é refeito do rascunho que já tem nota: sem emitir outra', async () => { // ADR-002
    const w = await drafted();
    const request = w.requests.rows[0]!.request;
    request.recordIssuance(await w.deps.notes.issue(7, request.note, '2026-11-12'));
    expect((await createSupplierUseCases(w.deps).send(41, BY)).kind).toBe('ok');
    expect(w.notes.issuedCount).toBe(1);
  });
});

describe('#11/AC-5 pedido que falhou sem nota registrada', () => { // ADR-002
  it('não emite pelo reenvio: o domínio só registra a nota a partir do rascunho', async () => { // ADR-002
    const w = await drafted();
    w.requests.rows[0]!.request.markSendFailed('estado antigo');
    expect(await createSupplierUseCases(w.deps).send(41, BY)).toEqual({ kind: 'conflict', reason: 'issuance_missing' });
    expect(w.notes.issuedCount).toBe(0);
    expect(w.mailer.sent).toEqual([]);
  });
});

describe('#11/AC-5 o que o motivo da falha carrega', () => { // ADR-002
  it('um erro lançado pelo envio vira motivo genérico, sem o texto do erro', async () => { // ADR-002
    const w = await drafted(fakeMailer(new Error('SMTP recusou a senha hunter2 em smtp.interno')));
    const result = await createSupplierUseCases(w.deps).send(41, BY);
    expect(result).toEqual({ kind: 'send_failed', reason: 'mailer_error', record: w.requests.rows[0] });
    expect(w.requests.rows[0]?.request.sendFailureReason).toBe('mailer_error');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('motivo em branco do envio vira um motivo genérico, para a falha ficar registrada', async () => { // ADR-002
    const w = await drafted(fakeMailer({ ok: false, reason: '  ' }));
    await createSupplierUseCases(w.deps).send(41, BY);
    expect(w.requests.rows[0]?.request.sendFailureReason).toBe('send_failed');
  });
});

describe('#11/AC-6 editar aceita só o corpo, revalidado', () => { // ADR-002
  it('troca o corpo e deixa assunto, lista e nota como estavam; devolve o corpo já com os números', async () => { // ADR-002
    const w = await drafted();
    const before = w.requests.rows[0]!.request;
    const note = before.note;
    const result = await createSupplierUseCases(w.deps).editBody(41, 'Pedimos o retorno até {{prazo}}.', BY);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.rendered.body).toBe('Pedimos o retorno até 17/11/2026.');
    expect(before.body).toBe('Pedimos o retorno até {{prazo}}.');
    expect(before.subject).toBe(GOOD_TEXT.subject);
    expect(before.asks).toEqual(GOOD_TEXT.asks);
    expect(before.note).toBe(note);
    expect(w.requests.saves).toBe(1);
    expect(w.requests.rows[0]?.stamps).toContainEqual({ by: BY, at: NOW, action: 'edited' });
  });

  it('número digitado fora do catálogo é recusado e o corpo anterior fica', async () => { // ADR-002
    const w = await drafted();
    const result = await createSupplierUseCases(w.deps).editBody(41, 'Devolvemos 999 caixas.', BY);
    expect(result).toEqual({ kind: 'invalid', reason: 'number_mismatch', field: 'body' });
    expect(w.requests.rows[0]?.request.body).toBe(GOOD_TEXT.body);
    expect(w.requests.saves).toBe(0);
  });

  it('só o rascunho se edita; o inexistente é not_found', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    expect(await useCases.editBody(99, 'texto', BY)).toEqual({ kind: 'not_found' });
    await useCases.send(41, BY);
    expect(await useCases.editBody(41, 'texto', BY)).toEqual({ kind: 'conflict', reason: 'not_draft' });
  });

  it('sem a nota de origem para refazer o catálogo, não edita', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases({ ...w.deps, source: { find: async () => null } });
    expect(await useCases.editBody(41, 'texto', BY)).toEqual({ kind: 'invalid', reason: 'source_missing' });
  });
});

describe('#11/AC-6 descartar respeita o ciclo do pedido', () => { // ADR-002
  it('descarta o rascunho com o motivo e quem descartou', async () => { // ADR-002
    const w = await drafted();
    const result = await createSupplierUseCases(w.deps).discard(41, BY, 'fornecedor já avisado por telefone');
    expect(result.kind).toBe('ok');
    expect(statusOf(w, 41)).toBe('discarded');
    expect(w.requests.rows[0]?.request.discardReason).toBe('fornecedor já avisado por telefone');
    expect(w.requests.rows[0]?.stamps).toContainEqual({ by: BY, at: NOW, action: 'discarded' });
  });

  it('motivo em branco é invalid; pedido enviado é conflito; inexistente é not_found', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    expect(await useCases.discard(41, BY, '  ')).toEqual({ kind: 'invalid', reason: 'reason_required' });
    expect(await useCases.discard(99, BY, 'x')).toEqual({ kind: 'not_found' });
    await useCases.send(41, BY);
    expect(await useCases.discard(41, BY, 'x')).toEqual({ kind: 'conflict', reason: 'not_draft' });
  });
});

describe('#11/AC-6 refazer respeita um pedido aberto por nota de origem e tipo', () => { // ADR-002
  it('depois de descartar, cria um rascunho novo pelo mesmo caminho da tarefa', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    await useCases.discard(41, BY, 'texto ruim');
    const result = await useCases.redraft(41, fakeAsk());
    expect(result.kind).toBe('ok');
    expect(statusOf(w, 42)).toBe('draft');
    expect(w.requests.rows[1]?.queueId).toBe(7);
    expect(w.notes.issuedCount).toBe(0);
  });

  it('com um pedido aberto para a nota, é conflito e o Claude nem é chamado', async () => { // ADR-002
    const w = await drafted();
    const ask = fakeAsk();
    expect(await createSupplierUseCases(w.deps).redraft(41, ask)).toEqual({ kind: 'conflict', reason: 'open_request_exists' });
    expect(ask.calls).toEqual([]);
  });

  it('com a devolução já fora da pendente, é conflito', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    await useCases.discard(41, BY, 'x');
    w.queue.views[0]!.status = 'cancelada';
    expect(await useCases.redraft(41, fakeAsk())).toEqual({ kind: 'conflict', reason: 'queue_not_pending' });
  });

  it('pedido inexistente é not_found; falha do Claude sobe como está', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    expect(await useCases.redraft(99, fakeAsk())).toEqual({ kind: 'not_found' });
    await useCases.discard(41, BY, 'x');
    const failure = new ClaudeError('rate_limit', 'limite', 429);
    await expect(useCases.redraft(41, fakeAsk(failure))).rejects.toBe(failure);
  });

  it('o texto recusado vira um pedido descartado com o motivo, e o resultado diz isso', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    await useCases.discard(41, BY, 'x');
    const result = await useCases.redraft(41, fakeAsk({ subject: 'oi' }));
    expect(result.kind === 'ok' && result.record.request.status).toBe('discarded');
  });
});

describe('#12/AC-4 o envio toma a trava antes de qualquer efeito', () => { // ADR-002
  it('trava o pedido depois de conferir o texto e antes de emitir, mover a fila ou enviar', async () => { // ADR-002
    const w = await drafted();
    expect((await createSupplierUseCases(w.deps).send(41, BY)).kind).toBe('ok');
    expect(w.requests.claims).toBe(1);
    expect(w.requests.releases).toBe(0);
  });

  it('trava recusada é conflito send_in_progress: nada é emitido, movido nem enviado', async () => { // ADR-002
    const w = await drafted();
    w.requests.refuseClaim = true;
    expect(await createSupplierUseCases(w.deps).send(41, BY)).toEqual({ kind: 'conflict', reason: 'send_in_progress' });
    expect(w.notes.issuedCount).toBe(0);
    expect(w.queue.emitCalls).toEqual([]);
    expect(w.mailer.sent).toEqual([]);
  });

  it('o texto inválido nem chega a tomar a trava', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases({ ...w.deps, source: { find: async () => null } });
    await useCases.send(41, BY);
    expect(w.requests.claims).toBe(0);
  });

  it('o envio que para depois da trava (fila já tratada) a solta, para edição e descarte voltarem', async () => { // ADR-002
    const w = await drafted();
    w.queue.views[0]!.status = 'cancelada';
    expect(await createSupplierUseCases(w.deps).send(41, BY)).toEqual({ kind: 'conflict', reason: 'queue_not_pending' });
    expect(w.requests.releases).toBe(1);
    expect(w.requests.rows[0]?.claim).toBeNull();
  });

  it('o envio que termina, bem ou mal, não solta a trava por conta própria: o último save a limpa', async () => { // ADR-002
    const ok = await drafted();
    await createSupplierUseCases(ok.deps).send(41, BY);
    const failed = await drafted(fakeMailer({ ok: false, reason: 'caixa_de_saida_indisponivel' }));
    await createSupplierUseCases(failed.deps).send(41, BY);
    expect([ok.requests.releases, failed.requests.releases]).toEqual([0, 0]);
    expect([ok.requests.rows[0]?.claim, failed.requests.rows[0]?.claim]).toEqual([null, null]);
  });

  it.each(['emitir a nota', 'mover a fila'])('erro ao %s, antes do e-mail, solta a trava e sobe; a nova tentativa não é send_in_progress', async (step) => { // ADR-002
    const w = await drafted();
    const boom = new Error('falha do dublê');
    const notes = w.notes.issue;
    const emit = w.queue.emit;
    if (step === 'emitir a nota') w.notes.issue = async () => Promise.reject(boom);
    else w.queue.emit = async () => Promise.reject(boom);
    const useCases = createSupplierUseCases(w.deps);
    await expect(useCases.send(41, BY)).rejects.toBe(boom);
    expect([w.requests.releases, w.requests.rows[0]?.claim, w.mailer.sent]).toEqual([1, null, []]);
    w.notes.issue = notes;
    w.queue.emit = emit;
    expect((await useCases.send(41, BY)).kind).toBe('ok');
  });

  it('erro ao registrar a emissão (save), antes do e-mail, também solta a trava', async () => { // ADR-002
    const w = await drafted();
    const save = w.requests.save;
    w.requests.save = async () => Promise.reject(new Error('banco fora'));
    await expect(createSupplierUseCases(w.deps).send(41, BY)).rejects.toThrow();
    w.requests.save = save;
    expect(w.requests.releases).toBe(1);
    expect(w.requests.rows[0]?.claim).toBeNull();
  });

  it('cada gravação do envio diz quem fez e quando', async () => { // ADR-002
    const w = await drafted(fakeMailer({ ok: false, reason: 'x' }));
    await createSupplierUseCases(w.deps).send(41, BY);
    expect(w.requests.rows[0]?.stamps.map((c) => [c.action, c.by, c.at])).toEqual([
      ['issued', BY, NOW],
      ['send_failed', BY, NOW],
    ]);
  });

  it('o e-mail leva a chave da trava, para o provedor deduplicar', async () => { // ADR-002
    const w = await drafted();
    await createSupplierUseCases(w.deps).send(41, BY);
    expect(w.mailer.sent[0]?.idempotencyKey).toBe('claim-1');
  });

  it('cada gravação do envio leva a chave da trava; edição e descarte não levam', async () => { // ADR-002
    const w = await drafted();
    await createSupplierUseCases(w.deps).send(41, BY);
    expect(w.requests.rows[0]?.stamps.map((c) => [c.action, c.claim])).toEqual([
      ['issued', 'claim-1'],
      ['sent', 'claim-1'],
    ]);
    const edit = await drafted();
    await createSupplierUseCases(edit.deps).editBody(41, 'Pedimos o retorno até {{prazo}}.', BY);
    expect(edit.requests.rows[0]?.stamps.map((c) => c.claim)).toEqual([undefined]);
  });

  it('o envio que para depois da trava a solta pela chave dela', async () => { // ADR-002
    const w = await drafted();
    w.queue.views[0]!.status = 'cancelada';
    const released: unknown[][] = [];
    const inner = w.requests.releaseSend;
    w.requests.releaseSend = async (...args) => {
      released.push(args);
      return inner(...args);
    };
    await createSupplierUseCases(w.deps).send(41, BY);
    expect(released.map((a) => [a[0], a[1]])).toEqual([[41, 'claim-1']]);
  });

  it('edição e descarte durante um envio em curso são stale, e o envio ainda grava enviado', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    const inflight = w.requests.claimSend(41, BY, NOW);
    const claimed = await inflight;
    expect(claimed.kind).toBe('claimed');
    expect(await useCases.editBody(41, 'Pedimos o retorno até {{prazo}}.', BY)).toEqual({ kind: 'conflict', reason: 'stale' });
    expect(await useCases.discard(41, BY, 'x')).toEqual({ kind: 'conflict', reason: 'stale' });
    expect(w.requests.rows[0]?.stamps).toEqual([]);
  });
});

describe('#12/AC-4 gravação que não achou a versão lida é conflito stale', () => { // ADR-002
  it('editar e descartar devolvem stale', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    w.requests.staleNext = true;
    expect(await useCases.editBody(41, 'Pedimos o retorno até {{prazo}}.', BY)).toEqual({ kind: 'conflict', reason: 'stale' });
    w.requests.staleNext = true;
    expect(await useCases.discard(41, BY, 'x')).toEqual({ kind: 'conflict', reason: 'stale' });
  });

  it('o registro da emissão que volta stale para o envio: nada é movido nem enviado, e a trava é solta', async () => { // ADR-002
    const w = await drafted();
    w.requests.staleNext = true;
    expect(await createSupplierUseCases(w.deps).send(41, BY)).toEqual({ kind: 'conflict', reason: 'stale' });
    expect(w.mailer.sent).toEqual([]);
    expect(w.queue.emitCalls).toEqual([]);
    expect(w.requests.releases).toBe(1);
  });

  it('o carimbo do envio que não foi gravado (trava perdida) também é stale, e o pedido não vira enviado', async () => { // ADR-002
    const w = await drafted();
    const useCases = createSupplierUseCases({
      ...w.deps,
      requests: { ...w.deps.requests, save: async (r, c) => (c.action === 'sent' ? 'stale' : w.requests.save(r, c)) },
    });
    expect(await useCases.send(41, BY)).toEqual({ kind: 'conflict', reason: 'stale' });
  });
});
