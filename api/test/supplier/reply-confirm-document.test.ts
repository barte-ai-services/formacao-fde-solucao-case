import { describe, expect, it } from 'vitest';
import type { DocumentConfirmation } from '../../src/domain/index.js';
import { createReplyUseCases } from '../../src/supplier/reply-use-cases.js';
import { NOW, TODAY, fakeMailer, noReply, parts, reading, replyRequest } from './reply-doubles.js';

// #63: o caso de uso que confirma o documento citado na leitura. Só uma pessoa o chama; nada sai ao fornecedor.
// Os nomes de `it` seguem o ADR-004.

const ANA = 'ana@jachegou.test';
const TO_CONFIRM = reading({ replyOutcome: 'fulfilled', supplierDocument: '881', nextStep: 'confirm_document' });
const ready = (over = {}) => replyRequest(7, { reading: TO_CONFIRM, ...over });

describe('#63/AC-1 confirmDocument grava o documento da leitura, quem confirmou e quando (ADR-005)', () => {
  it('#63/AC-1: o pedido em confirm_document ganha a confirmação com o documento, o e-mail de quem chamou e o relógio do caso de uso', async () => {
    const { deps, store } = parts([ready()]);
    const result = await createReplyUseCases(deps).confirmDocument(7, ANA);
    const expected: DocumentConfirmation = { document: '881', by: ANA, at: NOW };
    expect(result).toMatchObject({ kind: 'ok', request: { id: 7, documentConfirmation: expected } });
    expect(store.rows.get(7)?.documentConfirmation).toEqual(expected);
    expect(store.calls.map((c) => c.op)).toEqual(['confirmDocument']);
  });

  it('#63/AC-2: confirmado, o pedido sai de "precisam de você" e conta em "atendidos"', async () => {
    const { deps } = parts([ready()]);
    const useCases = createReplyUseCases(deps);
    expect((await useCases.listRequests('needs_you', TODAY)).counts).toMatchObject({ needs_you: 1, answered: 0 });
    await useCases.confirmDocument(7, ANA);
    const after = await useCases.listRequests('answered', TODAY);
    expect(after.counts).toEqual({ awaiting: 0, answered: 1, needs_you: 0, overdue: 0 });
    expect(after.rows.map((r) => r.id)).toEqual([7]);
  });
});

describe('#63/AC-4 confirmDocument recusa o que não está em confirm_document ou já foi confirmado', () => {
  it('#63/AC-4: pedido que não existe é not_found e nada é gravado', async () => {
    const { deps, store } = parts([]);
    expect(await createReplyUseCases(deps).confirmDocument(9, ANA)).toEqual({ kind: 'not_found' });
    expect(store.calls).toEqual([]);
  });

  it('#63/AC-4: sem leitura, no_reply, recusa ou outro próximo passo: conflict not_confirm_document, sem gravar', async () => {
    const cases = [
      replyRequest(7),
      replyRequest(7, { reading: noReply() }),
      replyRequest(7, { reading: reading({ replyOutcome: 'refused', nextStep: 'answer_supplier' }) }),
      replyRequest(7, { reading: reading({ supplierDocument: null, nextStep: 'close' }) }),
      replyRequest(7, { status: 'draft', reading: TO_CONFIRM }),
    ];
    for (const request of cases) {
      const { deps, store } = parts([request]);
      expect(await createReplyUseCases(deps).confirmDocument(7, ANA)).toEqual({ kind: 'conflict', reason: 'not_confirm_document' });
      expect(store.calls).toEqual([]);
    }
  });

  it('#63/AC-4: o documento já confirmado é conflict already_confirmed, e a primeira confirmação fica', async () => {
    const first: DocumentConfirmation = { document: '881', by: 'bia@jachegou.test', at: new Date('2026-11-19T09:00:00Z') };
    const { deps, store } = parts([ready({ documentConfirmation: first })]);
    expect(await createReplyUseCases(deps).confirmDocument(7, ANA)).toEqual({ kind: 'conflict', reason: 'already_confirmed' });
    expect(store.rows.get(7)?.documentConfirmation).toEqual(first);
    expect(store.calls).toEqual([]);
  });

  it('#63/AC-4: a corrida em que o armazém diz already_confirmed (outra chamada ganhou) vira conflict already_confirmed', async () => {
    const { deps, store } = parts([ready()]);
    store.confirmDocument = () => Promise.resolve('already_confirmed');
    expect(await createReplyUseCases(deps).confirmDocument(7, ANA)).toEqual({ kind: 'conflict', reason: 'already_confirmed' });
  });

  it('#63/AC-4: a versão que andou no meio vira conflict stale, para a pessoa reler', async () => {
    const { deps, store } = parts([ready()]);
    store.confirmDocument = () => Promise.resolve('stale');
    expect(await createReplyUseCases(deps).confirmDocument(7, ANA)).toEqual({ kind: 'conflict', reason: 'stale' });
  });
});

describe('#63/AC-5 e #63/AC-6 confirmar só grava a confirmação: nada sai, e nenhuma varredura confirma', () => {
  it('#63/AC-5: confirmar não manda e-mail ao fornecedor e não toca a leitura nem o prazo', async () => {
    const mailer = fakeMailer();
    const { deps, store } = parts([ready()], [], mailer);
    await createReplyUseCases(deps).confirmDocument(7, ANA);
    expect(mailer.sent).toEqual([]);
    expect(store.rows.get(7)).toMatchObject({ reading: TO_CONFIRM, status: 'sent', dueOn: '2026-11-17', followUp: { draft: null, sent: null } });
    expect(store.calls.map((c) => c.op)).toEqual(['confirmDocument']);
  });

  it('#63/AC-6: a varredura do prazo e a lista nunca confirmam: o pedido segue em needs_you', async () => {
    const { deps, store } = parts([ready(), replyRequest(8)]);
    const useCases = createReplyUseCases(deps);
    await useCases.sweepOverdue();
    await useCases.listRequests('needs_you', TODAY);
    expect(store.calls.map((c) => c.op)).not.toContain('confirmDocument');
    expect(store.rows.get(7)?.documentConfirmation).toBeNull();
  });
});
