/** #230/AC-6 e AC-1 A tarefa de ponta a ponta com os adaptadores do Supabase sobre um PostgREST roteirizado. */
import { describe, expect, it } from 'vitest';
import { ClaudeError, type Converse, type ConverseOptions } from '../../src/claude/client.js';
import { invoiceAuditTask } from '../../src/claude/tasks/invoice-audit.js';
import { auditTasksFor, tasksFor } from '../../src/claude/tasks/index.js';
import { SupabaseAuditReads } from '../../src/connectors/audit-reads.js';
import { SupabaseInvoiceAudits } from '../../src/connectors/invoice-audit-store.js';
import { scripted, type Call } from '../support/scripted-postgrest.js';

const KEY = '35261100000000000000550010000012341000012345';
const SEGREDO = 'segredo-do-banco-xyz';
const note = {
  classification: 'E4', dock_action: { kind: 'receber' }, approval_level: 'coordenacao', state: 'aguardando_aprovacao', invoice_access_key: KEY,
  invoices: {
    access_key: KEY, number: '1234', series: '1', supplier_id: 'F-001', store: 'L01', issued_on: '2026-11-10', purchase_order_ref: null,
    entry_channel: 'edi', total_cents: 100000, state: 'com_proposta', divergences: [],
    items: [{ supplierCode: 'A1', sku: null, description: 'Arroz', quantity: { amount: 2, unit: 'UN' }, unitPriceCents: 500, totalCents: 1000 }],
  },
};
const audit = {
  invoice_access_key: KEY, classification: 'E4', dock_action: 'receber', routing: 'diretoria',
  justification: 'um número: 12\nprocurei e não achei', amount_at_risk: { cents: 1000 },
};
const noAsk = async (): Promise<never> => { throw new Error('sem ask'); };
const call = async (o: ConverseOptions, name: string, input: unknown) => {
  try { return await o.tools?.find((t) => t.name === name)?.handler(input); } catch { return { is_error: true }; }
};
const respond = (c: Call) => {
  if (c.table === 'proposals' && c.method === 'GET') return { body: [note] };
  if (c.table === 'rpc/raise_proposal_level') return { body: 'diretoria' };
  if (c.table === 'kit_fornecedores') return { status: 500, body: { message: SEGREDO } };
  return { body: [{ id: 1 }] };
};
const build = (c = scripted(respond)) => ({
  ...c,
  task: invoiceAuditTask({ audits: new SupabaseInvoiceAudits(c.rest), reads: new SupabaseAuditReads(c.rest), now: () => new Date('2026-11-15T18:30:00Z'), model: 'm' }),
});

describe('invoice-audit com os adaptadores (#230)', () => {
  it('#230/AC-6: uma tool com erro de sistema deixa a nota não auditada com o motivo, sem o texto do erro, e a proposta não é tocada', async () => {
    const { task, calls } = build();
    const converse: Converse = async (o) => { await call(o, 'get_supplier', { supplier_id: 'F-001' }); await call(o, 'record_audit', audit); return { recorded: true }; };
    const error = await task.run({ invoiceAccessKey: KEY }, noAsk, converse).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain(SEGREDO);
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes.map((w) => `${w.method} ${w.table}`)).toEqual(['POST invoice_audits']);
    expect(writes[0]?.body).toEqual([{ invoice_access_key: KEY, status: 'nao_auditada', reason: 'erro_de_tool', refusals: [] }]);
  });

  it('#230/AC-6: o Claude falhando deixa a nota não auditada (claude_falhou) e o laço segue', async () => {
    const { task, calls } = build();
    await task.run({ invoiceAccessKey: KEY }, noAsk, async () => { throw new ClaudeError('api', 'x'); }).catch(() => undefined);
    expect(calls.filter((c) => c.method === 'POST').map((c) => (c.body as { reason: string }[])[0]?.reason)).toEqual(['claude_falhou']);
  });

  it('#230/AC-1 e AC-3: auditada, grava a linha uma vez e sobe o nível da proposta que aguarda', async () => {
    const { task, calls } = build();
    await task.run({ invoiceAccessKey: KEY }, noAsk, async (o) => { await call(o, 'record_audit', audit); return { recorded: true }; });
    expect(calls.map((c) => `${c.method} ${c.table}`)).toEqual(['GET proposals', 'GET kit_notas_lancadas', 'GET kit_pagamentos', 'POST invoice_audits', 'POST rpc/raise_proposal_level']); // #337 as leituras de antes do laço (a nota não cita ordem: só a busca por número)
  });

  it('#333/AC-2: a tarefa vem registrada na lista do cron do auditor, e não no laço de 15 minutos (#230)', () => {
    const { rest } = scripted();
    expect(auditTasksFor(rest).map((t) => t.name)).toEqual(['invoice-audit']);
    const names = tasksFor(rest).map((t) => t.name);
    expect(names).not.toContain('invoice-audit');
    expect(names.slice(0, 2)).toEqual(['description-match', 'supplier-reply-reading']);
    expect(names).toContain('probable-order');
  });
});
