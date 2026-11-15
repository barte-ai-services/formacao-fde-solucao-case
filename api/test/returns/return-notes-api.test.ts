import { describe, expect, it } from 'vitest';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { erpReturnNoteOutbox } from '../../src/connectors/erp-return-note.js';
import { Quantity } from '../../src/domain/index.js';
import type { AccessVerifier } from '../../src/http/access.js';
import type { Env } from '../../src/env.js';
import { createWorker } from '../../src/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitInvoiceRows, kitNotes } from '../dock/kit-invoices.js';

// #140 A fila de notas de devolução pendentes de emissão: a caixa outbox_return_notes como fila de trabalho.

const ENV: Env = {
  ACCESS_AUD: 'aud',
  ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com',
  BARTE_ACADEMY_SUPABASE_URL: 'https://supabase.test',
  BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_teste',
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const NOW = new Date('2026-11-15T15:00:00Z');

function setup(email: string | null = 'fiscal@jachegou.test') {
  const verifier: AccessVerifier = { verify: async () => ({ ok: true, identity: { email } }) };
  const fake = new FakePostgrest({ invoices: kitInvoiceRows() });
  const rest = new SupabaseRest({ url: 'https://supabase.test', secretKey: 'sb_teste', fetch: fake.fetch });
  const worker = createWorker({
    verifier,
    returnNotes: { supabase: (env) => (env.BARTE_ACADEMY_SUPABASE_URL ? rest : null), now: () => NOW },
  });
  const call = (path: string, method = 'GET', body?: unknown, env: Env = ENV) =>
    worker.fetch(
      new Request(`https://worker.test${path}`, {
        method,
        headers: { 'Cf-Access-Jwt-Assertion': 'token', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      ctx,
    );
  const outbox = erpReturnNoteOutbox(rest);
  return { fake, call, outbox };
}

const note = kitNotes()[0]!;
const item = note.itens[0]!;
const REASON = `E3 quantidade menor na nota ${note.numero}: devolução da diferença`;
const publishNote = (outbox: ReturnType<typeof erpReturnNoteOutbox>, amount = 4) =>
  outbox.publish({
    invoiceAccessKey: note.chave,
    reason: REASON,
    lines: [{ supplierCode: item.codigo_fornecedor, quantity: Quantity.of(amount, item.unidade) }],
  });

type Listed = {
  id: number;
  status: string;
  invoiceAccessKey: string;
  invoiceNumber: string | null;
  supplierId: string | null;
  reason: string;
  valueCents: number | null;
  pendingSeconds: number | null;
  lines: { supplierCode: string; description: string; quantity: { amount: number; unit: string }; valueCents: number | null }[];
  emitted: { number: string; by: string; at: string } | null;
  cancelled: { justification: string; by: string; at: string } | null;
};

describe('#140 GET /api/return-notes', () => {
  it('AC-1/AC-2 lista a devolução pendente com nota de origem, fornecedor, itens, valor, motivo e há quanto tempo', async () => {
    const { fake, call, outbox } = setup();
    await publishNote(outbox);
    (fake.rows('outbox_return_notes')[0] as Record<string, unknown>).published_at = '2026-11-15T12:30:00Z';

    const response = await call('/api/return-notes');

    expect(response.status).toBe(200);
    const { notes } = (await response.json()) as { notes: Listed[] };
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      status: 'pendente',
      invoiceAccessKey: note.chave,
      invoiceNumber: String(note.numero),
      supplierId: note.fornecedor_id,
      reason: REASON,
      valueCents: Math.round(item.preco_unitario * 100) * 4,
      pendingSeconds: 2.5 * 3600,
      lines: [
        {
          supplierCode: item.codigo_fornecedor,
          description: item.descricao,
          quantity: { amount: 4, unit: item.unidade },
          valueCents: Math.round(item.preco_unitario * 100) * 4,
        },
      ],
    });
  });

  it('AC-1 publicar a mesma devolução duas vezes mostra uma só na fila', async () => {
    const { call, outbox } = setup();
    await publishNote(outbox);
    await publishNote(outbox);

    const { notes } = (await (await call('/api/return-notes')).json()) as { notes: Listed[] };

    expect(notes).toHaveLength(1);
  });

  it('a fila padrão traz só as pendentes; ?status= escolhe outro estado', async () => {
    const { call, outbox } = setup();
    const a = await publishNote(outbox, 4);
    await publishNote(outbox, 5);
    await call(`/api/return-notes/${a.id}/issue`, 'POST', { nfeNumber: '123456' });

    const pending = (await (await call('/api/return-notes')).json()) as { notes: Listed[] };
    const emitted = (await (await call('/api/return-notes?status=emitida')).json()) as { notes: Listed[] };

    expect(pending.notes.map((n) => n.status)).toEqual(['pendente']);
    expect(emitted.notes.map((n) => n.id)).toEqual([a.id]);
  });

  it('nota de origem que a tabela não conhece vira linha sem fornecedor e sem valor, e não derruba a fila', async () => {
    const { call, outbox } = setup();
    await outbox.publish({
      invoiceAccessKey: 'CHAVE-SEM-NOTA',
      reason: 'E3',
      lines: [{ supplierCode: 'X', quantity: Quantity.of(1, 'UN') }],
    });

    const { notes } = (await (await call('/api/return-notes')).json()) as { notes: Listed[] };

    expect(notes[0]).toMatchObject({ invoiceNumber: null, supplierId: null, valueCents: null });
  });

  it('estado fora da lista responde 400; sem credenciais do Supabase, 503', async () => {
    const { call } = setup();
    expect((await call('/api/return-notes?status=x')).status).toBe(400);
    expect((await call('/api/return-notes', 'GET', undefined, { ...ENV, BARTE_ACADEMY_SUPABASE_URL: undefined })).status).toBe(503);
  });
});

describe('#140 POST /api/return-notes/:id/issue', () => {
  it('AC-3 marca como emitida com o número da NF-e, quem e quando', async () => {
    const { fake, call, outbox } = setup();
    const { id } = await publishNote(outbox);

    const response = await call(`/api/return-notes/${id}/issue`, 'POST', { nfeNumber: ' 123456 ' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Listed;
    expect(body).toMatchObject({
      id,
      status: 'emitida',
      emitted: { number: '123456', by: 'fiscal@jachegou.test', at: NOW.toISOString() },
    });
    expect(fake.rows('outbox_return_notes')[0]).toMatchObject({
      status: 'emitida',
      nfe_number: '123456',
      emitted_by: 'fiscal@jachegou.test',
      emitted_at: NOW.toISOString(),
    });
  });

  it.each([[{}], [{ nfeNumber: '' }], [{ nfeNumber: '   ' }], [{ nfeNumber: 'abc' }], [{ nfeNumber: 12 }]])(
    'AC-3 sem o número da NF-e (%j) responde 400 e a nota segue pendente',
    async (body) => {
      const { fake, call, outbox } = setup();
      const { id } = await publishNote(outbox);

      const response = await call(`/api/return-notes/${id}/issue`, 'POST', body);

      expect(response.status).toBe(400);
      expect(fake.rows('outbox_return_notes')[0]).toMatchObject({ status: 'pendente' });
    },
  );

  it('emitir de novo, ou emitir a cancelada, responde 409 e não muda nada', async () => {
    const { fake, call, outbox } = setup();
    const { id } = await publishNote(outbox);
    await call(`/api/return-notes/${id}/issue`, 'POST', { nfeNumber: '1' });

    const again = await call(`/api/return-notes/${id}/issue`, 'POST', { nfeNumber: '2' });

    expect(again.status).toBe(409);
    expect(fake.rows('outbox_return_notes')[0]).toMatchObject({ nfe_number: '1' });
  });

  it('nota que não existe responde 404; identidade sem e-mail, 403', async () => {
    const { call } = setup();
    expect((await call('/api/return-notes/999/issue', 'POST', { nfeNumber: '1' })).status).toBe(404);

    const anonymous = setup(null);
    const { id } = await publishNote(anonymous.outbox);
    expect((await anonymous.call(`/api/return-notes/${id}/issue`, 'POST', { nfeNumber: '1' })).status).toBe(403);
  });
});

describe('#140 POST /api/return-notes/:id/cancel', () => {
  it('cancela a pendente com a justificativa, quem e quando', async () => {
    const { fake, call, outbox } = setup();
    const { id } = await publishNote(outbox);

    const response = await call(`/api/return-notes/${id}/cancel`, 'POST', { justification: ' Fornecedor mandou o crédito ' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'cancelada',
      cancelled: { justification: 'Fornecedor mandou o crédito', by: 'fiscal@jachegou.test', at: NOW.toISOString() },
    });
    expect(fake.rows('outbox_return_notes')[0]).toMatchObject({ status: 'cancelada', cancel_justification: 'Fornecedor mandou o crédito' });
  });

  it('sem justificativa responde 400; cancelar a emitida responde 409', async () => {
    const { call, outbox } = setup();
    const { id } = await publishNote(outbox);
    expect((await call(`/api/return-notes/${id}/cancel`, 'POST', { justification: '  ' })).status).toBe(400);

    await call(`/api/return-notes/${id}/issue`, 'POST', { nfeNumber: '1' });
    expect((await call(`/api/return-notes/${id}/cancel`, 'POST', { justification: 'engano' })).status).toBe(409);
  });

  it('id que não é número responde 404, e método errado 405', async () => {
    const { call } = setup();
    expect((await call('/api/return-notes/abc/cancel', 'POST', { justification: 'x' })).status).toBe(404);
    expect((await call('/api/return-notes/1/cancel', 'GET')).status).toBe(405);
  });
});
