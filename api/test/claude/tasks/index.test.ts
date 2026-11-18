import { describe, expect, it } from 'vitest';
import { CRON_LIMIT, runClaudeRound } from '../../../src/claude/cron.js';
import { MAX_PER_RUN } from '../../../src/claude/runner.js';
import { tasksFor } from '../../../src/claude/tasks/index.js';
import type { Db } from '../../../src/claude/db.js';
import { PROBABLE_ORDER_TASK } from '../../../src/connectors/probable-order-suggestions.js';
import { SUPPLIER_DRAFT_TASK, type SupplierDraftInput } from '../../../src/supplier/draft-task.js';
import { GOOD_TEXT, SUPPLIER_EMAIL, draftInput, fakeAsk } from '../../supplier/doubles.js';
import { harness, invoiceRow, queueRow, supplierRow } from '../../supplier/supabase-support.js';

// #12: o registro das tarefas do Claude leva a tarefa do rascunho do pedido ao fornecedor (#2).

const db: Db = { select: async () => [], upsert: async () => [] };
const seed = () => ({ outbox_return_notes: [queueRow()], invoices: [invoiceRow()], kit_fornecedores: [supplierRow()] });

describe('#12/AC-6 a tarefa do rascunho entra no registro das tarefas do Claude', () => { // ADR-002
  it('o registro tem a tarefa do pedido ao fornecedor', () => { // ADR-002
    const { rest } = harness();
    expect(tasksFor(rest).map((t) => t.name)).toContain(SUPPLIER_DRAFT_TASK);
  });

  it('a tarefa lista a devolução pendente e grava o rascunho no banco, para o e-mail do fornecedor, feito pelo agente', async () => { // ADR-002
    const { fake, rest } = harness(seed());
    const task = tasksFor(rest).find((t) => t.name === SUPPLIER_DRAFT_TASK);
    const { requests } = await task!.pending(db);
    expect(requests.map((r) => r.key)).toEqual(['return_note:7']);
    const output = await task!.run(requests[0]!.input as SupplierDraftInput, fakeAsk(GOOD_TEXT));
    expect(output).toEqual({ requestId: 1, status: 'draft' });
    const [row] = fake.rows('outbox_supplier_emails');
    expect(row).toMatchObject({ status: 'draft', recipient: SUPPLIER_EMAIL, queue_id: 7, supplier_id: 'F02' });
    expect((row?.history as { by: string }[])[0]?.by).toBe('agente');
  });

  it('com o rascunho feito, a devolução não volta à lista da tarefa; o rascunho nunca emite nota nem envia', async () => { // ADR-002
    const { fake, rest } = harness(seed());
    const task = tasksFor(rest).find((t) => t.name === SUPPLIER_DRAFT_TASK)!;
    await task.run(draftInput(), fakeAsk(GOOD_TEXT));
    expect((await task.pending(db)).requests).toEqual([]);
    expect(fake.rows('issued_return_notes')).toEqual([]);
    expect(fake.rows('outbox_return_notes')[0]?.status).toBe('pendente');
  });

  it('a rodada do Cron sem credencial do Claude não faz nenhum pedido ao banco e não grava rascunho', async () => { // ADR-002
    const { fake, rest } = harness(seed());
    const lines: string[] = [];
    const round = await runClaudeRound(rest, {}, { log: (l) => lines.push(l) });
    expect(round.ran).toBe(false);
    expect(fake.requests).toEqual([]);
    expect(fake.rows('outbox_supplier_emails')).toEqual([]);
  });
});

describe('#36/AC-4 o teto efetivo de cada tarefa numa rodada do Cron é o menor entre o da tarefa e o da rodada', () => {
  it('#36/AC-4: a conta de subrequests de api/src/claude/cron.ts vale: 1, 1, 2, 1, 1 (#58: a cobrança saiu do Cron; #230: o auditor, maxPerRun 1)', () => {
    const { rest } = harness();
    const effective = Object.fromEntries(tasksFor(rest).map((t) => [t.name, Math.min(t.limit ?? MAX_PER_RUN, t.maxPerRun ?? MAX_PER_RUN, CRON_LIMIT)]));
    expect(effective).toEqual({
      'description-match': 1,
      [PROBABLE_ORDER_TASK]: 1,
      [SUPPLIER_DRAFT_TASK]: 2,
      'supplier-reply-reading': 1,
      'invoice-audit': 1, // #230 maxPerRun 1
    });
  });

  it('#36/AC-4: o casamento de descrição e a ordem provável têm limite próprio de 1, e a rodada é só um teto de 2', () => {
    const { rest } = harness();
    const byName = new Map(tasksFor(rest).map((t) => [t.name, t]));
    expect(byName.get('description-match')?.limit).toBe(1);
    expect(byName.get(PROBABLE_ORDER_TASK)?.limit).toBe(1);
    expect(CRON_LIMIT).toBe(2);
  });

  it('#36/AC-4: a leitura da #4 vem antes da ordem provável, para não passar fome primeiro quando o Worker esgota as subrequests', () => {
    const { rest } = harness();
    expect(tasksFor(rest).map((t) => t.name)).toEqual([
      'description-match',
      'supplier-reply-reading',
      PROBABLE_ORDER_TASK,
      SUPPLIER_DRAFT_TASK,
      'invoice-audit', // #230 por último: a mais cara, com tool use
    ]);
  });
});

describe('#58/AC-1 a cobrança é montada pela regra na varredura, e a tarefa do Claude saiu do registro', () => {
  it('#58/AC-1: o registro não tem a tarefa supplier-follow-up-draft', () => {
    const { rest } = harness();
    expect(tasksFor(rest).map((t) => t.name)).not.toContain('supplier-follow-up-draft');
  });
});
