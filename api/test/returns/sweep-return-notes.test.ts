import { describe, expect, it } from 'vitest';
import type { ReturnNoteMessage } from '../../src/connectors/ports.js';
import { DockAction, Quantity } from '../../src/domain/index.js';
import type { DecidedReturnSource } from '../../src/returns/decided-return-source.js';
import type { DecidedReturnCase } from '../../src/returns/publish-return-note.js';
import { sweepReturnNotes } from '../../src/returns/sweep-return-notes.js';
import { decided, KEY, memoryOutbox, OTHER_KEY, partialE3 } from './support.js';

/** #7 Fonte em memória das decisões: devolve os casos dados e conta as leituras. */
function memorySource(cases: readonly DecidedReturnCase[]) {
  const calls = { listDecided: 0 };
  const source: DecidedReturnSource = {
    listDecided: () => {
      calls.listDecided += 1;
      return Promise.resolve(cases);
    },
  };
  return { source, calls };
}

const queued = (accessKey: string): ReturnNoteMessage => ({
  invoiceAccessKey: accessKey,
  lines: [{ supplierCode: 'F08-001', quantity: Quantity.of(1, 'UN') }],
  reason: 'já na fila',
});

describe('a varredura das decisões: sweepReturnNotes', () => {
  it('#1/AC-6 #7/AC-2: publica a devolução de toda decisão que devolve e ainda não está na fila', async () => {
    const { outbox, rows } = memoryOutbox();
    const { source } = memorySource([
      decided('E3', partialE3()),
      decided('E3', partialE3(), {}, OTHER_KEY),
      decided('MATCH', DockAction.receive(), {}, '35261100000000000000550010000077771000077777'),
    ]);
    const result = await sweepReturnNotes(source, outbox);
    expect(result).toEqual({ published: 2, alreadyQueued: 0, withoutReturn: 1 });
    expect(rows.map((r) => r.invoiceAccessKey)).toEqual([KEY, OTHER_KEY]);
  });

  it('#1/AC-7 #7/AC-3: com tudo na fila, em qualquer situação, não publica de novo', async () => {
    const { outbox, calls } = memoryOutbox([queued(KEY), queued(OTHER_KEY)]);
    const { source } = memorySource([decided('E3', partialE3()), decided('E3', partialE3(), {}, OTHER_KEY)]);
    const result = await sweepReturnNotes(source, outbox);
    expect(result).toEqual({ published: 0, alreadyQueued: 2, withoutReturn: 0 });
    expect(calls.publish).toBe(0);
  });

  it('#1/AC-7 #7/AC-3: rodar duas vezes seguidas deixa uma linha só por nota', async () => {
    const { outbox, rows } = memoryOutbox();
    const { source } = memorySource([decided('E3', partialE3())]);
    await sweepReturnNotes(source, outbox);
    const second = await sweepReturnNotes(source, outbox);
    expect(second.published).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it('#1/AC-7 #7/AC-3: duas decisões da mesma nota na mesma rodada publicam uma vez só', async () => {
    const { outbox, rows } = memoryOutbox();
    const { source } = memorySource([decided('E3', partialE3()), decided('E3', partialE3())]);
    const result = await sweepReturnNotes(source, outbox);
    expect(result.published).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it('#1/AC-6 #7/AC-2: uma leitura da fonte, uma listagem da fila e uma publicação por nota nova', async () => {
    const { outbox, calls } = memoryOutbox([queued(OTHER_KEY)]);
    const { source, calls: sourceCalls } = memorySource([
      decided('E3', partialE3()),
      decided('E3', partialE3(), {}, OTHER_KEY),
    ]);
    await sweepReturnNotes(source, outbox);
    expect(sourceCalls.listDecided).toBe(1);
    expect(calls.list).toBe(1);
    expect(calls.publish).toBe(1);
  });

  it('#1/AC-8 #7/AC-2: sem decisão que devolva, não publica nada', async () => {
    const { outbox, calls } = memoryOutbox();
    const { source } = memorySource([decided('E5', DockAction.receive())]);
    expect(await sweepReturnNotes(source, outbox)).toEqual({ published: 0, alreadyQueued: 0, withoutReturn: 1 });
    expect(calls.publish).toBe(0);
  });

  it('#9/AC-2: com limite, para ao publicar o limite e a rodada seguinte continua do que faltou', async () => {
    const { outbox, rows } = memoryOutbox();
    const third = '35261100000000000000550010000066661000066666';
    const { source } = memorySource([
      decided('E3', partialE3()),
      decided('E3', partialE3(), {}, OTHER_KEY),
      decided('E3', partialE3(), {}, third),
    ]);

    const first = await sweepReturnNotes(source, outbox, 2);
    expect(first.published).toBe(2);
    expect(rows.map((r) => r.invoiceAccessKey)).toEqual([KEY, OTHER_KEY]);

    const next = await sweepReturnNotes(source, outbox, 2);
    expect(next.published).toBe(1);
    expect(rows.map((r) => r.invoiceAccessKey)).toEqual([KEY, OTHER_KEY, third]);
  });

  it('#9/AC-2: o limite conta só o que publica: nota já na fila e decisão sem devolução não gastam', async () => {
    const { outbox, rows } = memoryOutbox([queued(KEY)]);
    const { source } = memorySource([
      decided('E3', partialE3()),
      decided('E5', DockAction.receive(), {}, '35261100000000000000550010000055551000055555'),
      decided('E3', partialE3(), {}, OTHER_KEY),
      decided('E3', partialE3(), {}, '35261100000000000000550010000044441000044444'),
    ]);
    const result = await sweepReturnNotes(source, outbox, 1);
    expect(result.published).toBe(1);
    expect(rows.map((r) => r.invoiceAccessKey)).toEqual([KEY, OTHER_KEY]);
  });
});
