import { describe, expect, it, vi } from 'vitest';
import { erpReturnNoteOutbox } from '../../src/connectors/erp-return-note.js';
import { SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { publishReturnNote } from '../../src/returns/publish-return-note.js';
import { SupabaseDecidedReturnSource } from '../../src/returns/supabase-decided-source.js';
import { sweepReturnNotes } from '../../src/returns/sweep-return-notes.js';
import { awaiting, decide, proposedWorld, returnFirstItem } from './supabase-decided-source.support.js';

// #156 A leitura das decisões que devolvem, sobre o PostgREST falso com o kit e o Cron já rodado (14 decididas pela regra).

describe('#156 o adaptador lê as decisões: listDecided', () => {
  it('#156: lê aprovada e alterada com a ação, o dia da decisão, a nota e os recebimentos, e não lê as outras', async () => {
    const { fake, rest } = await proposedWorld();
    const e3 = awaiting(fake, 'E3');
    const e1 = awaiting(fake, 'E1');
    const registrada = awaiting(fake, 'E2');
    registrada.state = 'registrada';
    decide(fake, e3, { state: 'alterada', action: returnFirstItem(fake, e3), decidedOn: '2026-11-12' });
    decide(fake, e1, { state: 'aprovada', action: returnFirstItem(fake, e1), decidedOn: null });

    const decided = await new SupabaseDecidedReturnSource(rest).listDecided();

    const byKey = new Map(decided.map((d) => [d.invoice.accessKey, d]));
    expect(decided).toHaveLength(14 + 2);
    expect(byKey.get(String(e3.invoice_access_key))?.decision).toMatchObject({ classification: 'E3', state: 'alterada', decidedOn: '2026-11-12' });
    expect(byKey.get(String(e3.invoice_access_key))?.decision.dockAction.kind).toBe('receber_parcial');
    // #156 decided_on nulo cai no dia de approved_at.
    expect(byKey.get(String(e1.invoice_access_key))?.decision).toMatchObject({ state: 'aprovada', decidedOn: '2026-11-13' });
    expect(byKey.has(String(registrada.invoice_access_key))).toBe(false);
    expect(byKey.has(String(awaiting(fake, 'E4').invoice_access_key))).toBe(false);
    const one = decided[0];
    expect(one?.receipts).toHaveLength(fake.rows('kit_recebimentos').length);
    expect(one?.products).toHaveLength(fake.rows('kit_produtos').length);
    expect(one?.invoice.items.length).toBeGreaterThan(0);
  });

  it('#156: a nota da decisão sai com as divergências e o estado gravados', async () => {
    const { fake, rest } = await proposedWorld();
    const e3 = awaiting(fake, 'E3');
    decide(fake, e3, { state: 'aprovada', action: returnFirstItem(fake, e3), decidedOn: '2026-11-12' });
    const decided = await new SupabaseDecidedReturnSource(rest).listDecided();
    const invoice = decided.find((d) => d.invoice.accessKey === e3.invoice_access_key)?.invoice;
    expect(invoice?.classification).toBe('E3');
    expect(invoice?.divergences.length).toBeGreaterThan(0);
  });

  it('#156: lê em um número fixo de requisições: 4 leituras, todas GET, e nenhuma por decisão', async () => {
    const { fake, rest } = await proposedWorld();
    const first = awaiting(fake, 'E3', 0);
    decide(fake, first, { state: 'aprovada', action: returnFirstItem(fake, first), decidedOn: '2026-11-12' });
    fake.requests.length = 0;
    await new SupabaseDecidedReturnSource(rest).listDecided();
    const once = fake.requests.length;
    const second = awaiting(fake, 'E3', 0);
    decide(fake, second, { state: 'aprovada', action: returnFirstItem(fake, second), decidedOn: '2026-11-12' });
    fake.requests.length = 0;
    await new SupabaseDecidedReturnSource(rest).listDecided();
    expect(once).toBe(4);
    expect(fake.requests).toHaveLength(4);
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
  });
});

describe('#156 linha fora do formato vira erro sem repetir os dados', () => {
  const secret = 'segredo-nao-numerico';

  it('proposta com campo fora do formato', async () => {
    const { fake, rest } = await proposedWorld();
    const e3 = awaiting(fake, 'E3');
    decide(fake, e3, { state: 'aprovada', action: returnFirstItem(fake, e3), decidedOn: '2026-11-12' });
    e3.classification = secret;
    const error = await new SupabaseDecidedReturnSource(rest).listDecided().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseRestError);
    expect(error).toMatchObject({ operation: 'parse', table: 'proposals' });
    expect(String(error)).not.toContain(secret);
  });

  it('ação parcial fora do formato', async () => {
    const { fake, rest } = await proposedWorld();
    const e3 = awaiting(fake, 'E3');
    decide(fake, e3, { state: 'aprovada', action: returnFirstItem(fake, e3), decidedOn: '2026-11-12' });
    e3.dock_action = { kind: 'receber_parcial', lines: [{ sku: secret }] };
    const error = await new SupabaseDecidedReturnSource(rest).listDecided().catch((e: unknown) => e);
    expect(error).toMatchObject({ operation: 'parse', table: 'proposals' });
    expect(String(error)).not.toContain(secret);
  });

  it('nota com valor fora do formato', async () => {
    const { fake, rest } = await proposedWorld();
    const e3 = awaiting(fake, 'E3');
    decide(fake, e3, { state: 'aprovada', action: returnFirstItem(fake, e3), decidedOn: '2026-11-12' });
    const invoice = fake.rows('invoices').find((i) => i.access_key === e3.invoice_access_key);
    if (invoice) invoice.total_cents = secret;
    const error = await new SupabaseDecidedReturnSource(rest).listDecided().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseRestError);
    expect(error).toMatchObject({ operation: 'parse' });
    expect(String(error)).not.toContain(secret);
  });

  it('proposta decidida sem aprovação: pula a linha e registra só a chave e o motivo, e as outras decisões continuam lidas', async () => {
    const { fake, rest } = await proposedWorld();
    const e3 = awaiting(fake, 'E3');
    e3.state = 'aprovada';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const decided = await new SupabaseDecidedReturnSource(rest).listDecided();
      expect(decided).toHaveLength(14);
      expect(decided.some((d) => d.invoice.accessKey === e3.invoice_access_key)).toBe(false);
      const written = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(written).toContain(String(e3.invoice_access_key));
      expect(written).toContain('sem aprovação');
      expect(written).not.toContain(String(e3.dock_action));
    } finally {
      log.mockRestore();
    }
  });

  it('proposta decidida sem aprovação: a varredura publica as outras decisões da mesma leitura', async () => {
    const { fake, rest } = await proposedWorld();
    const e3 = awaiting(fake, 'E3');
    e3.state = 'aprovada';
    const e1 = awaiting(fake, 'E1');
    decide(fake, e1, { state: 'aprovada', action: returnFirstItem(fake, e1), decidedOn: '2026-11-13' });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { published } = await sweepReturnNotes(new SupabaseDecidedReturnSource(rest), erpReturnNoteOutbox(rest), 20);
      expect(published).toBeGreaterThan(0);
      const keys = fake.rows('outbox_return_notes').map((r) => r.invoice_access_key);
      expect(keys).toContain(e1.invoice_access_key);
      expect(keys).not.toContain(e3.invoice_access_key);
    } finally {
      log.mockRestore();
    }
  });

  it('recebimento fora do formato', async () => {
    const { fake, rest } = await proposedWorld();
    const [receipt] = fake.rows('kit_recebimentos');
    if (receipt) receipt.data = 12345;
    const error = await new SupabaseDecidedReturnSource(rest).listDecided().catch((e: unknown) => e);
    expect(error).toMatchObject({ operation: 'parse', table: 'kit_recebimentos' });
  });
});

describe('#156 a varredura sobre a fonte e a caixa de saída do Supabase', () => {
  it('#156: publicar a mesma nota duas vezes deixa uma linha só em outbox_return_notes', async () => {
    const { fake, rest } = await proposedWorld();
    const e3 = awaiting(fake, 'E3');
    decide(fake, e3, { state: 'alterada', action: returnFirstItem(fake, e3), decidedOn: '2026-11-12' });
    const [one] = (await new SupabaseDecidedReturnSource(rest).listDecided()).filter((d) => d.invoice.accessKey === e3.invoice_access_key);
    if (!one) throw new Error('decisão não lida');
    const outbox = erpReturnNoteOutbox(rest);
    const first = await publishReturnNote(one, outbox);
    const second = await publishReturnNote(one, outbox);
    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(fake.rows('outbox_return_notes')).toHaveLength(1);
  });

  it('#156: a decisão sem devolução na fila é publicada na rodada, e a seguinte não grava nada', async () => {
    const { fake, rest } = await proposedWorld();
    const e3 = awaiting(fake, 'E3');
    decide(fake, e3, { state: 'alterada', action: returnFirstItem(fake, e3), decidedOn: '2026-11-12' });
    const source = new SupabaseDecidedReturnSource(rest);
    const outbox = erpReturnNoteOutbox(rest);
    const first = await sweepReturnNotes(source, outbox);
    const second = await sweepReturnNotes(source, outbox);
    expect(first).toEqual({ published: 1, alreadyQueued: 0, withoutReturn: 14 });
    expect(second).toEqual({ published: 0, alreadyQueued: 1, withoutReturn: 14 });
    expect(fake.rows('outbox_return_notes')).toHaveLength(1);
    expect(fake.rows('outbox_return_notes')[0]).toMatchObject({ invoice_access_key: e3.invoice_access_key, status: 'pendente' });
  });

  it('#156: a devolução já emitida ou cancelada na fila não é publicada de novo', async () => {
    const { fake, rest } = await proposedWorld();
    const a = awaiting(fake, 'E3', 0);
    const b = awaiting(fake, 'E3', 1);
    decide(fake, a, { state: 'aprovada', action: returnFirstItem(fake, a), decidedOn: '2026-11-12' });
    decide(fake, b, { state: 'aprovada', action: returnFirstItem(fake, b), decidedOn: '2026-11-12' });
    const source = new SupabaseDecidedReturnSource(rest);
    const outbox = erpReturnNoteOutbox(rest);
    await sweepReturnNotes(source, outbox);
    const [first, second] = fake.rows('outbox_return_notes');
    if (first) first.status = 'emitida';
    if (second) second.status = 'cancelada';
    const again = await sweepReturnNotes(source, outbox);
    expect(again).toMatchObject({ published: 0, alreadyQueued: 2 });
    expect(fake.rows('outbox_return_notes')).toHaveLength(2);
  });

  it('#156: uma rodada faz 4 leituras da fonte, 1 da fila e 1 gravação por nota nova', async () => {
    const { fake, rest } = await proposedWorld();
    const e3 = awaiting(fake, 'E3');
    decide(fake, e3, { state: 'aprovada', action: returnFirstItem(fake, e3), decidedOn: '2026-11-12' });
    const source = new SupabaseDecidedReturnSource(rest);
    const outbox = erpReturnNoteOutbox(rest);
    fake.requests.length = 0;
    await sweepReturnNotes(source, outbox);
    expect(fake.requests.map((r) => r.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET', 'POST']);
    fake.requests.length = 0;
    await sweepReturnNotes(source, outbox);
    expect(fake.requests.map((r) => r.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET']);
  });
});
