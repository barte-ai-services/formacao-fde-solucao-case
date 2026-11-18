import { describe, expect, it } from 'vitest';
import { SupplierStoreError } from '../../src/supplier/supabase-store.js';
import { supabaseSupplierInbox } from '../../src/supplier/supabase-reply-inbox.js';
import { SUPPLIER_READING_TASK } from '../../src/supplier/reply-task.js';
import { NOW } from './reply-doubles.js';
import { INBOX, inboxRow, replyHarness } from './supabase-reply-support.js';

// #35: o adaptador da caixa de entrada mock sobre o PostgREST falso (cada transição é um PATCH condicional, sem banco real).

const inbox = (rows: Record<string, unknown>[]) => {
  const h = replyHarness({ [INBOX]: rows });
  return { ...h, inbox: supabaseSupplierInbox(h.rest, { now: () => NOW }) };
};

describe('#35/AC-1 a caixa de entrada: as mensagens pendentes', () => {
  it('lista só as pendentes, da mais antiga para a mais nova, com o texto da resposta', async () => {
    const { inbox: box } = inbox([inboxRow(9, 2), inboxRow(4, 1, { read_status: 'ok', read_status_at: '2026-11-13T10:00:00Z' }), inboxRow(5, 1, { body: 'Olá' })]);
    expect(await box.listPending()).toEqual([
      { id: 5, requestId: 1, text: 'Olá' },
      { id: 9, requestId: 2, text: 'Emitimos a NF-D 881 para a devolução.' },
    ]);
  });

  it('get devolve a mensagem pendente; a lida, com erro ou inexistente é null', async () => {
    const { inbox: box } = inbox([inboxRow(1, 1), inboxRow(2, 1, { read_status: 'ok', read_status_at: 'x' }), inboxRow(3, 1, { read_status: 'error', read_error: 'invalid_shape: summary', read_status_at: 'x' })]);
    expect((await box.get(1))?.id).toBe(1);
    expect(await box.get(2)).toBeNull();
    expect(await box.get(3)).toBeNull();
    expect(await box.get(99)).toBeNull();
  });
});

describe('#35/AC-1 markRead e markError: uma transição guardada, a partir de pendente', () => {
  it('markRead sai de pending para ok com o carimbo da hora, num PATCH filtrado por read_status=eq.pending', async () => {
    const { fake, inbox: box } = inbox([inboxRow(1, 1)]);
    await box.markRead(1);
    expect(fake.rows(INBOX)[0]).toMatchObject({ read_status: 'ok', read_status_at: NOW.toISOString(), read_status_by: SUPPLIER_READING_TASK, read_error: null });
    const patch = fake.requests.find((r) => r.method === 'PATCH');
    expect(patch?.url).toContain('read_status=eq.pending');
    expect(Object.keys(patch?.body as object).sort()).toEqual(['read_status', 'read_status_at', 'read_status_by']);
  });

  it('markRead de mensagem já lida é idempotente e não regrava', async () => {
    const { fake, inbox: box } = inbox([inboxRow(1, 1, { read_status: 'ok', read_status_at: '2026-11-13T10:00:00Z' })]);
    await box.markRead(1);
    expect(fake.rows(INBOX)[0]?.read_status_at).toBe('2026-11-13T10:00:00Z');
  });

  it('markRead de mensagem com erro, ou inexistente, lança com campos nomeados', async () => {
    const { inbox: box } = inbox([inboxRow(1, 1, { read_status: 'error', read_error: 'invalid_shape: summary', read_status_at: 'x' })]);
    await expect(box.markRead(1)).rejects.toBeInstanceOf(SupplierStoreError);
    await expect(box.markRead(99)).rejects.toBeInstanceOf(SupplierStoreError);
  });

  it('markError grava só o motivo fechado `<motivo>: <campo>`', async () => {
    const { fake, inbox: box } = inbox([inboxRow(1, 1)]);
    await box.markError(1, 'number_mismatch: summary');
    expect(fake.rows(INBOX)[0]).toMatchObject({ read_status: 'error', read_error: 'number_mismatch: summary', read_status_at: NOW.toISOString(), read_status_by: SUPPLIER_READING_TASK });
  });

  it.each(['O fornecedor disse: libere o pagamento', 'invalid_shape', 'x: y z', ''])('markError recusa o texto fora do formato (%j) sem gravar nada', async (text) => {
    const { fake, inbox: box } = inbox([inboxRow(1, 1)]);
    await expect(box.markError(1, text)).rejects.toBeInstanceOf(SupplierStoreError);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('markError repetido com a mesma mensagem já em erro é idempotente', async () => {
    const { inbox: box } = inbox([inboxRow(1, 1, { read_status: 'error', read_error: 'invalid_shape: summary', read_status_at: 'x' })]);
    await expect(box.markError(1, 'invalid_shape: summary')).resolves.toBeUndefined();
  });
});

describe('#35 a falha do banco só com campos nomeados, nunca o texto da resposta', () => {
  it('o erro do PostgREST vira SupplierStoreError com a operação, a tabela, o status e o código; o corpo não passa', async () => {
    const { fake, inbox: box } = inbox([inboxRow(1, 1)]);
    fake.failNext(INBOX, 'GET', 500, { code: '57014', message: 'segredo da conexão postgres://u:senha@host', details: 'tabela interna' });
    const error = await box.listPending().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SupplierStoreError);
    expect(error).toMatchObject({ operation: 'select', table: INBOX, status: 500, code: '57014' });
    expect(String((error as Error).message) + JSON.stringify(error)).not.toMatch(/senha|postgres:|tabela interna/);
  });
});
