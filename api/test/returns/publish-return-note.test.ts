import { describe, expect, it } from 'vitest';
import { DockAction } from '../../src/domain/index.js';
import { publishReturnNote } from '../../src/returns/publish-return-note.js';
import { decided, memoryOutbox, OTHER_KEY, partialE3, receipt, KEY } from './support.js';

describe('publicar a devolução de uma decisão: publishReturnNote', () => {
  it('#156: decisão que devolve grava a nota na caixa de saída e a devolve', async () => {
    const { outbox, rows } = memoryOutbox();
    const published = await publishReturnNote(decided('E3', partialE3()), outbox);
    expect(rows).toHaveLength(1);
    expect(published?.invoiceAccessKey).toBe(KEY);
    expect(rows[0]?.lines.map((l) => [l.supplierCode, l.quantity.amount, l.quantity.unit])).toEqual([['F08-001', 20, 'UN']]);
  });

  it('#156: decisão que não devolve não grava nada e devolve null', async () => {
    const { outbox, rows, calls } = memoryOutbox();
    expect(await publishReturnNote(decided('MATCH', DockAction.receive()), outbox)).toBeNull();
    expect(await publishReturnNote(decided('E4', DockAction.receive()), outbox)).toBeNull();
    expect(rows).toHaveLength(0);
    expect(calls.publish).toBe(0);
  });

  it('#156: recusa sem recebimento até o dia da decisão não grava nada', async () => {
    const { outbox, rows } = memoryOutbox();
    const late = [receipt('RC-9', '2026-11-13', [['F08-001', 100]])];
    expect(await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: late }), outbox)).toBeNull();
    expect(await publishReturnNote(decided('E1', DockAction.refuse()), outbox)).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('#156: recusa com um recebimento do dia da decisão devolve o que entrou', async () => {
    const { outbox, rows } = memoryOutbox();
    const r = [receipt('RC-1', '2026-11-12', [['F08-001', 40]])];
    await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: r }), outbox);
    expect(rows[0]?.lines.map((l) => [l.supplierCode, l.quantity.amount])).toEqual([['F08-001', 40]]);
  });

  it('#156: nota contada em mais de um recebimento junta todos os itens, sem subcontar', async () => {
    const { outbox, rows } = memoryOutbox();
    const r = [
      receipt('RC-1', '2026-11-11', [['F08-001', 40]]),
      receipt('RC-2', '2026-11-12', [['F08-001', 30], ['F08-003', 10]]),
    ];
    await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: r }), outbox);
    expect(rows[0]?.lines.map((l) => [l.supplierCode, l.quantity.amount])).toEqual([
      ['F08-001', 70],
      ['F08-003', 10],
    ]);
  });

  it('#156: só entram os recebimentos do dia da decisão ou anteriores', async () => {
    const { outbox, rows } = memoryOutbox();
    const r = [receipt('RC-1', '2026-11-12', [['F08-001', 40]]), receipt('RC-2', '2026-11-13', [['F08-001', 30]])];
    await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: r }), outbox);
    expect(rows[0]?.lines.map((l) => l.quantity.amount)).toEqual([40]);
  });

  it('#156: recebimento de outra nota ou sem nota não entra na soma', async () => {
    const { outbox, rows } = memoryOutbox();
    const r = [
      receipt('RC-1', '2026-11-12', [['F08-001', 40]]),
      receipt('RC-2', '2026-11-12', [['F08-001', 30]], OTHER_KEY),
      receipt('RC-3', '2026-11-12', [['F08-001', 20]], null),
    ];
    await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: r }), outbox);
    expect(rows[0]?.lines.map((l) => l.quantity.amount)).toEqual([40]);
  });

  it('#156: a ordem dos recebimentos não muda a nota publicada', async () => {
    const a = memoryOutbox();
    const b = memoryOutbox();
    const r = [receipt('RC-1', '2026-11-11', [['F08-001', 40]]), receipt('RC-2', '2026-11-12', [['F08-003', 10]])];
    await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: r }), a.outbox);
    await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: [...r].reverse() }), b.outbox);
    expect(a.rows[0]?.lines).toEqual(b.rows[0]?.lines);
  });
});
