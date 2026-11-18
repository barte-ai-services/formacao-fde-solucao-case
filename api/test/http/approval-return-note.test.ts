import { afterEach, describe, expect, it, vi } from 'vitest';
import { dockActionToJson } from '../../src/approval/supabase-store.js';
import type { DockActionOutbox, ReturnNoteOutbox } from '../../src/connectors/ports.js';
import { erpReturnNoteOutbox } from '../../src/connectors/erp-return-note.js';
import { SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { DockAction } from '../../src/domain/index.js';
import { SupabaseDecidedReturnSource } from '../../src/returns/supabase-decided-source.js';
import { sweepReturnNotes } from '../../src/returns/sweep-return-notes.js';
import { addReceipt, clearReceipts, assembled, invoiceOf, keyOf } from '../returns/acceptance.support.js';
import { awaiting, returnFirstItem } from '../returns/supabase-decided-source.support.js';

// #156 A rota de decisão publica a devolução (#156 a AC-5, AC-7, AC-8; #156) sobre o kit e o PostgREST falso.

afterEach(() => vi.restoreAllMocks());

const partial = (action: DockAction): unknown => dockActionToJson(action);

describe('#156 a rota aprova ou altera e a devolução entra na fila', () => {
  it('#156: E3 alterada para receber parcial com linhas devolver entra pendente, com quantidade x preço do item', async () => {
    const world = await assembled();
    const e3 = awaiting(world.fake, 'E3');
    const item = (await invoiceOf(world.rest, e3)).items[0]!;

    const res = await world.alter(keyOf(e3), partial(returnFirstItem(world.fake, e3)));

    expect(res.status).toBe(200);
    const notes = await world.queue();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      invoiceAccessKey: keyOf(e3),
      status: 'pendente',
      valueCents: item.unitPrice.cents,
      lines: [{ supplierCode: item.supplierCode, quantity: { amount: 1, unit: item.quantity.unit }, valueCents: item.unitPrice.cents }],
    });
  });

  it('#156: E1 alterada para receber parcial entra na fila com as linhas da ação', async () => {
    const world = await assembled();
    const e1 = awaiting(world.fake, 'E1');
    const item = (await invoiceOf(world.rest, e1)).items[0]!;

    expect((await world.alter(keyOf(e1), partial(returnFirstItem(world.fake, e1)))).status).toBe(200);

    const notes = await world.queue();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ invoiceAccessKey: keyOf(e1), lines: [{ supplierCode: item.supplierCode, quantity: { amount: 1, unit: item.quantity.unit } }] });
  });

  it('#156: E2 alterada para receber parcial entra na fila só com o item trocado', async () => {
    const world = await assembled();
    const e2 = awaiting(world.fake, 'E2');
    const item = (await invoiceOf(world.rest, e2)).items[0]!;

    expect((await world.alter(keyOf(e2), partial(returnFirstItem(world.fake, e2)))).status).toBe(200);

    const notes = await world.queue();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.lines.map((l) => l.supplierCode)).toEqual([item.supplierCode]);
  });

  it('#156: recusa de nota com recebimento do dia da decisão entra com os itens recebidos, no limite da nota', async () => {
    const world = await assembled();
    const note = awaiting(world.fake, 'E3');
    clearReceipts(world.fake, keyOf(note));
    const item = (await invoiceOf(world.rest, note)).items[0]!;
    // #156 Recebeu o dobro do que a nota traz: a linha sai no limite da nota. Recebimento do próprio dia vale.
    addReceipt(world.fake, keyOf(note), '2026-11-15', [[item.supplierCode, item.quantity.amount * 2, item.quantity.unit]]);

    expect((await world.alter(keyOf(note), { kind: 'recusar' })).status).toBe(200);

    const notes = await world.queue();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.lines[0]).toMatchObject({ supplierCode: item.supplierCode, quantity: { amount: item.quantity.amount, unit: item.quantity.unit } });
  });

  it('#156: recusa sem recebimento registrado não entra na fila e a decisão vale', async () => {
    const world = await assembled();
    const note = awaiting(world.fake, 'E3');
    clearReceipts(world.fake, keyOf(note));

    expect((await world.alter(keyOf(note), { kind: 'recusar' })).status).toBe(200);

    expect(await world.queue()).toEqual([]);
    expect(world.fake.rows('outbox_return_notes')).toHaveLength(0);
    expect(note.state).toBe('alterada');
  });

  it('#156: recebimento posterior ao dia da decisão não conta e a recusa fica fora da fila', async () => {
    const world = await assembled();
    const note = awaiting(world.fake, 'E3');
    clearReceipts(world.fake, keyOf(note));
    const item = (await invoiceOf(world.rest, note)).items[0]!;
    addReceipt(world.fake, keyOf(note), '2026-11-16', [[item.supplierCode, item.quantity.amount, item.quantity.unit]]);

    expect((await world.alter(keyOf(note), { kind: 'recusar' })).status).toBe(200);

    expect(world.fake.rows('outbox_return_notes')).toHaveLength(0);
  });
});

describe('#156 publicar de novo não duplica', () => {
  it('#156: a rota, a segunda decisão e a varredura deixam uma linha só', async () => {
    const world = await assembled();
    const e3 = awaiting(world.fake, 'E3');
    const action = partial(returnFirstItem(world.fake, e3));
    expect((await world.alter(keyOf(e3), action)).status).toBe(200);
    expect((await world.alter(keyOf(e3), action)).status).toBe(409);

    await sweepReturnNotes(new SupabaseDecidedReturnSource(world.rest), erpReturnNoteOutbox(world.rest));

    expect(world.fake.rows('outbox_return_notes').filter((r) => r.invoice_access_key === keyOf(e3))).toHaveLength(1);
  });

  it('#156: devolução já emitida na fila não é publicada de novo pela varredura', async () => {
    const world = await assembled();
    const e3 = awaiting(world.fake, 'E3');
    expect((await world.alter(keyOf(e3), partial(returnFirstItem(world.fake, e3)))).status).toBe(200);
    const [queued] = await world.queue();
    const issued = await world.call(`/api/return-notes/${queued!.id}/issue`, { method: 'POST', body: JSON.stringify({ nfeNumber: '123' }) });
    expect(issued.status).toBe(200);

    const result = await sweepReturnNotes(new SupabaseDecidedReturnSource(world.rest), erpReturnNoteOutbox(world.rest));

    expect(result.alreadyQueued).toBeGreaterThan(0);
    expect(world.fake.rows('outbox_return_notes').filter((r) => r.invoice_access_key === keyOf(e3))).toHaveLength(1);
  });
});

describe('#156 o que não devolve fica fora da fila', () => {
  it('#156: receber, e recusa de E4, E5, E6 e E8 (o E7 vai na varredura) com recebimento registrado, não entram', async () => {
    const world = await assembled();
    const e3 = awaiting(world.fake, 'E3');
    expect((await world.alter(keyOf(e3), { kind: 'receber' })).status).toBe(200);
    for (const classification of ['E4', 'E5', 'E6', 'E8']) {
      const note = awaiting(world.fake, classification);
      const item = (await invoiceOf(world.rest, note)).items[0]!;
      addReceipt(world.fake, keyOf(note), '2026-11-14', [[item.supplierCode, item.quantity.amount, item.quantity.unit]], `RC-${classification}`);
      expect((await world.alter(keyOf(note), { kind: 'recusar' })).status, classification).toBe(200);
    }
    expect(world.fake.rows('outbox_return_notes')).toHaveLength(0);
  });
});

describe('#156 a falha de publicar não desfaz a decisão', () => {
  const failing: ReturnNoteOutbox = {
    publish: () => Promise.reject(new SupabaseRestError('insert', 'outbox_return_notes', 503, 'corpo-secreto-do-erp')),
    list: () => Promise.resolve([]),
  };

  it('#156: o ERP falha, a decisão vale e o log leva só a chave e o status', async () => {
    const world = await assembled({ returnOutbox: () => failing });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e3 = awaiting(world.fake, 'E3');

    const res = await world.alter(keyOf(e3), partial(returnFirstItem(world.fake, e3)));

    expect(res.status).toBe(200);
    expect(e3.state).toBe('alterada');
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes(keyOf(e3)) && l.includes('HTTP 503'))).toBe(true);
    expect(lines.join('\n')).not.toContain('corpo-secreto-do-erp');
  });

  it('#156: a devolução que falhou na rota entra pela varredura, depois', async () => {
    const world = await assembled({ returnOutbox: () => failing });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const e3 = awaiting(world.fake, 'E3');
    await world.alter(keyOf(e3), partial(returnFirstItem(world.fake, e3)));
    expect(world.fake.rows('outbox_return_notes')).toHaveLength(0);

    await sweepReturnNotes(new SupabaseDecidedReturnSource(world.rest), erpReturnNoteOutbox(world.rest));

    expect(world.fake.rows('outbox_return_notes').some((r) => r.invoice_access_key === keyOf(e3))).toBe(true);
  });

  it('#156: a falha da doca não pula a devolução, e a da devolução não pula a doca', async () => {
    const brokenDock: DockActionOutbox = { publish: () => Promise.reject(new Error('WMS fora')), list: () => Promise.resolve([]) };
    const dockFails = await assembled({ dockOutbox: () => brokenDock });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = awaiting(dockFails.fake, 'E3');
    expect((await dockFails.alter(keyOf(a), partial(returnFirstItem(dockFails.fake, a)))).status).toBe(200);
    expect(dockFails.fake.rows('outbox_return_notes').some((r) => r.invoice_access_key === keyOf(a))).toBe(true);

    const returnFails = await assembled({ returnOutbox: () => failing });
    const b = awaiting(returnFails.fake, 'E3');
    expect((await returnFails.alter(keyOf(b), partial(returnFirstItem(returnFails.fake, b)))).status).toBe(200);
    const docked = [...returnFails.fake.rows('outbox_dock_actions'), ...returnFails.fake.rows('outbox_store_actions')];
    expect(docked.some((r) => r.invoice_access_key === keyOf(b))).toBe(true);
  });
});

describe('#156 o contrato da resposta de aprovar e alterar não muda', () => {
  it('#156: aprovar e alterar respondem só approval e title, com os mesmos campos de antes', async () => {
    const world = await assembled();
    const e3 = awaiting(world.fake, 'E3');
    const altered = await world.alter(keyOf(e3), partial(returnFirstItem(world.fake, e3)));
    const body = (await altered.json()) as { approval: Record<string, unknown>; title: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(['approval', 'title']);
    expect(Object.keys(body.approval).sort()).toEqual(['approver', 'approverLevel', 'decidedOn', 'dockAction', 'justification']);
    expect(Object.keys(body.title).sort()).toEqual(['amount', 'state']);

    const e1 = awaiting(world.fake, 'E1');
    const approved = await world.approve(keyOf(e1));
    expect(approved.status).toBe(200);
    const second = (await approved.json()) as { approval: Record<string, unknown>; title: Record<string, unknown> };
    expect(Object.keys(second).sort()).toEqual(['approval', 'title']);
    expect(Object.keys(second.approval).sort()).toEqual(['approver', 'approverLevel', 'decidedOn', 'dockAction', 'justification']);
  });
});
