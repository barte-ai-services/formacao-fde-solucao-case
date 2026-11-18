import { describe, expect, it } from 'vitest';
import { supplierDeps } from '../../src/supplier/supabase-deps.js';
import { createSupplierUseCases } from '../../src/supplier/use-cases.js';
import { NOW, fakeAsk, fakeMailer } from './doubles.js';
import { draftRequest } from '../../src/supplier/draft.js';
import { harness, invoiceRow, queueRow, supplierRow } from './supabase-support.js';

// #12: as portas do pedido ao fornecedor ligadas ao Supabase, do rascunho ao envio, sobre o PostgREST falso.

const seed = () => ({ outbox_return_notes: [queueRow()], invoices: [invoiceRow()], kit_fornecedores: [supplierRow()] });

describe('#12/AC-5 do rascunho ao envio pela caixa de saída mock', () => { // ADR-002
  it('rascunha, emite a nota uma vez, move a fila e envia pelo mock: o pedido guarda o canal e o envio', async () => { // ADR-002
    const { fake, rest } = harness(seed());
    const deps = supplierDeps(rest, { clock: { now: () => NOW } });
    const drafted = await draftRequest(deps, 7, fakeAsk());
    expect(drafted.kind).toBe('ok');
    const result = await createSupplierUseCases(deps).send(1, 'ana@jachegou.example');
    expect(result.kind).toBe('ok');
    expect(fake.rows('issued_return_notes')).toHaveLength(1);
    expect(fake.rows('outbox_return_notes')[0]).toMatchObject({ status: 'emitida', nfe_number: '1', emitted_by: 'ana@jachegou.example' });
    expect(fake.rows('outbox_supplier_emails')[0]).toMatchObject({
      status: 'sent',
      channel: 'mock',
      sent_by: 'ana@jachegou.example',
      issued_return_note_id: 1,
      send_claim: null,
    });
    expect(String(fake.rows('outbox_supplier_emails')[0]?.provider_message_id)).toMatch(/^mock-/);
    expect(fake.rows('outbox_supplier_emails')[0]?.attachments).toEqual([
      { filename: 'nota-devolucao-ND-1.json', content_type: 'application/json', issued_return_note_id: 1 },
      { filename: 'nota-devolucao-ND-1.pdf', content_type: 'application/pdf', issued_return_note_id: 1 }, // #57/AC-1
    ]);
  });

  it('o mock não grava na tabela do pedido: o único escritor da linha do pedido é o adaptador do pedido', async () => { // ADR-002
    const { fake, rest } = harness(seed());
    const deps = supplierDeps(rest, { clock: { now: () => NOW } });
    await draftRequest(deps, 7, fakeAsk());
    const before = fake.requests.length;
    await deps.mailer.send({
      invoiceAccessKey: 'k',
      supplierId: 'F02',
      requestType: 'return_note',
      to: 'a@b.test',
      subject: 's',
      body: 'b',
      asks: [],
      attachments: [],
      dueOn: '2026-11-17',
      idempotencyKey: 'x',
    });
    expect(fake.requests.length).toBe(before);
  });

  it('enviar duas vezes seguidas não manda dois e-mails nem emite outra nota', async () => { // ADR-002
    const { fake, rest } = harness(seed());
    const deps = supplierDeps(rest, { clock: { now: () => NOW } });
    await draftRequest(deps, 7, fakeAsk());
    const useCases = createSupplierUseCases(deps);
    await useCases.send(1, 'ana@jachegou.example');
    expect(await useCases.send(1, 'ana@jachegou.example')).toEqual({ kind: 'conflict', reason: 'not_sendable' });
    expect(fake.rows('issued_return_notes')).toHaveLength(1);
  });
});

describe('#12/AC-4 dois envios ao mesmo tempo do mesmo pedido', () => { // ADR-002
  const BY = 'ana@jachegou.example';

  const twoSends = async (separateInstances: boolean) => {
    const { fake, rest } = harness(seed());
    const mailer = fakeMailer();
    const first = supplierDeps(rest, { clock: { now: () => NOW }, mailer });
    const second = separateInstances ? supplierDeps(rest, { clock: { now: () => NOW }, mailer }) : first;
    await draftRequest(first, 7, fakeAsk());
    const results = await Promise.all([createSupplierUseCases(first).send(1, BY), createSupplierUseCases(second).send(1, BY)]);
    return { fake, mailer, results };
  };

  it.each([
    ['na mesma instância do adaptador', false],
    ['em instâncias separadas sobre o mesmo banco', true],
  ] as const)('%s: sai um e-mail só, uma nota só, e o que perdeu é send_in_progress', async (_name, separate) => { // ADR-002
    const { fake, mailer, results } = await twoSends(separate);
    expect(mailer.sent).toHaveLength(1);
    expect(fake.rows('issued_return_notes')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'conflict')).toEqual([{ kind: 'conflict', reason: 'send_in_progress' }]);
    expect(fake.rows('outbox_supplier_emails')[0]).toMatchObject({ status: 'sent', send_claim: null });
  });
});
