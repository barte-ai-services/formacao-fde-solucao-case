// #157 #356 O mundo da conta de subrequests: a Messages API falsa e o pior caso do kit com a fila cheia de cada tarefa (de test/claude/budget.test.ts).
import { expect, vi } from 'vitest';
import type { FetchFn } from '../../src/claude/client.js';
import { tick } from '../../src/cron/tick.js';
import { queueRow, invoiceRow } from '../supplier/supabase-support.js';
import { GOOD_TEXT } from '../supplier/doubles.js';
import { SOURCE_KEY } from '../domain/supplier-request-fixtures.js';
import { kitTables } from './kit.js';
import { AFTER_DUE, READING } from './reply-scenarios.js';
import { supplierWorld, type SupplierWorld } from './supplier-world.js';
import { sweepSupplierOverdue } from '../../src/cron/supplier-sweep.js';

export const ENV = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake', BARTE_ACADEMY_ANTHROPIC_API_KEY: 'chave-de-teste' };
export const OTHER_KEYS = ['35261112345678000195550010000438950000438952', '35261112345678000195550010000438960000438963', '35261112345678000195550010000438970000438974'];

/** #157: a Messages API falsa: responde a ferramenta que a tarefa pediu, conforme o esquema dela, e conta as chamadas (#157: a cobrança já não pergunta ao Claude). */
export function messagesApi(proposalOf: (key: string) => Record<string, unknown> | undefined, auditTurns = 2): { fetch: FetchFn; calls: () => number } {
  let calls = 0;
  const fetch: FetchFn = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as {
      tools: { name: string; input_schema: { properties: Record<string, unknown> } }[];
      messages: unknown[];
    };
    // #230 O auditor (invoice-audit) conversa com tools: na 1ª volta grava a auditoria que concorda com a régua (record_audit), na 2ª entrega a resposta final.
    if (body.tools.some((t) => t.name === 'record_audit')) {
      // #333 A volta é o que o laço já mandou: cada volta acrescenta 2 mensagens (a do modelo e a das tools). Com `auditTurns` > 2 o modelo lê antes de gravar, sempre a mesma nota (o pior caso passa do AUDIT_MAX_READS = 12: as leituras a mais voltam recusadas).
      const turn = (body.messages.length - 1) / 2 + 1;
      if (turn === auditTurns) return reply('responder', { audited: true });
      if (turn < auditTurns - 1) return reply('get_invoice', { invoice_access_key: /<chave>([^<]*)<\/chave>/.exec(JSON.stringify(body.messages[0]))?.[1] ?? '' });
      const key = /<chave>([^<]*)<\/chave>/.exec(JSON.stringify(body.messages[0]))?.[1] ?? '';
      const row = proposalOf(key) ?? {};
      const audit = {
        invoice_access_key: key,
        classification: row.classification,
        dock_action: (row.dock_action as { kind?: string } | undefined)?.kind,
        routing: row.approval_level,
        justification: 'A ordem de compra confirma a nota: 12 itens.\nO preço bate com o pedido.',
        amount_at_risk: null,
      };
      return reply('record_audit', audit);
    }
    const keys = Object.keys(body.tools[0]?.input_schema.properties ?? {});
    const input = keys.includes('reply_outcome')
      ? READING
      : keys.includes('match')
        ? { match: null }
        : keys.includes('orderId')
          ? { orderId: null, reason: 'sem ordem provável' }
          : GOOD_TEXT;
    return reply('responder', input);
  };
  return { fetch, calls: () => calls };
}

/** #157: uma resposta da Messages API com uma só chamada de tool. */
export function reply(name: string, input: unknown): Response {
  return new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'tu', name, input }] }), { status: 200 });
}

/** #230 O auditor gasta 2 chamadas à Messages API por nota (grava a auditoria, depois entrega a resposta); as outras tarefas, 1 por pedido. */
export const AUDIT_CALLS_PER_NOTE = 2;

/** #157: o pior caso: o kit inteiro conferido, dois pedidos enviados, duas devoluções novas na fila e, depois do prazo, um pedido atrasado e outro com resposta para ler. */
export async function fullWorld(): Promise<{ world: SupplierWorld; sweep: number }> {
  const w = await supplierWorld({ emptyQueue: false });
  for (const [table, rows] of Object.entries(kitTables())) w.fake.tables.set(table, rows);
  w.fake.tables.set('claude_suggestions', []);
  vi.stubGlobal('fetch', w.fake.fetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T15:00:00Z'));
  await tick({ cron: '*/15 * * * *' }, { BARTE_ACADEMY_SUPABASE_URL: ENV.BARTE_ACADEMY_SUPABASE_URL, BARTE_ACADEMY_SUPABASE_SECRET_KEY: ENV.BARTE_ACADEMY_SUPABASE_SECRET_KEY });
  vi.useRealTimers();
  // #157: dois pedidos enviados: um fica sem resposta (a cobrança) e o outro recebe a resposta (a leitura).
  const [second, third, ...extra] = OTHER_KEYS;
  w.fake.tables.set('invoices', [...w.fake.rows('invoices'), ...OTHER_KEYS.map((key) => ({ ...invoiceRow(), access_key: key }))]);
  w.fake.tables.set('outbox_return_notes', [...w.fake.rows('outbox_return_notes'), { ...queueRow(8), invoice_access_key: second }]);
  await w.runCron();
  for (const key of [SOURCE_KEY, second as string]) expect((await w.call('POST', w.path('/send', key), { body: {} })).status).toBe(200);
  // #157: duas devoluções novas na fila, para o rascunho do #156 (limite 2) ter o que fazer.
  w.fake.tables.set('outbox_return_notes', [...w.fake.rows('outbox_return_notes'), { ...queueRow(9), invoice_access_key: third }, { ...queueRow(10), invoice_access_key: extra[0] }]);
  w.setNow(AFTER_DUE);
  const before = w.fake.requests.length;
  await sweepSupplierOverdue(w.rest, { now: () => AFTER_DUE });
  const sweep = w.fake.requests.length - before;
  const marked = w.fake.rows('supplier_reply_readings').map((r) => Number(r.request_id));
  const open = w.fake.rows('outbox_supplier_emails').map((r) => Number(r.id)).find((id) => !marked.includes(id));
  w.receive('Emitimos a NF-D 881.', open);
  w.receive('Segue o comprovante.', open);
  return { world: w, sweep };
}

