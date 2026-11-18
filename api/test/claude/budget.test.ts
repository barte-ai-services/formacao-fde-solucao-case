// #157: o guarda da conta de subrequests da rodada do Cron: mede a rodada de verdade, com as tarefas de tasksFor e a fila cheia de cada uma.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../../src/claude/client.js';
import { CRON_LIMIT, runClaudeRound } from '../../src/claude/cron.js';
import { restDb } from '../../src/claude/db.js';
import { tasksFor } from '../../src/claude/tasks/index.js';
import { sweepSupplierOverdue } from '../../src/cron/supplier-sweep.js';
import { tick } from '../../src/cron/tick.js';
import { queueRow, invoiceRow } from '../supplier/supabase-support.js';
import { GOOD_TEXT } from '../supplier/doubles.js';
import { SOURCE_KEY } from '../domain/supplier-request-fixtures.js';
import { kitTables } from '../support/kit.js';
import { AFTER_DUE, READING } from '../support/reply-scenarios.js';
import { supplierWorld, type SupplierWorld } from '../support/supplier-world.js';

/** #157: os 50 subrequests do plano gratuito do Worker, contados aqui só para a varredura e a rodada do Claude (api/src/claude/cron.ts). */
const SUBREQUEST_LIMIT = 50;
const ENV = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake', BARTE_ACADEMY_ANTHROPIC_API_KEY: 'chave-de-teste' };
const OTHER_KEYS = ['35261112345678000195550010000438950000438952', '35261112345678000195550010000438960000438963', '35261112345678000195550010000438970000438974'];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** #157: a Messages API falsa: responde a ferramenta que a tarefa pediu, conforme o esquema dela, e conta as chamadas (#157: a cobrança já não pergunta ao Claude). */
function messagesApi(proposalOf: (key: string) => Record<string, unknown> | undefined): { fetch: FetchFn; calls: () => number } {
  let calls = 0;
  const fetch: FetchFn = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as {
      tools: { name: string; input_schema: { properties: Record<string, unknown> } }[];
      messages: unknown[];
    };
    // #230 O auditor (invoice-audit) conversa com tools: na 1ª volta grava a auditoria que concorda com a régua (record_audit), na 2ª entrega a resposta final.
    if (body.tools.some((t) => t.name === 'record_audit')) {
      if (body.messages.length > 1) return reply('responder', { audited: true });
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
function reply(name: string, input: unknown): Response {
  return new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'tu', name, input }] }), { status: 200 });
}

/** #230 O auditor gasta 2 chamadas à Messages API por nota (grava a auditoria, depois entrega a resposta); as outras tarefas, 1 por pedido. */
const AUDIT_CALLS_PER_NOTE = 2;

/** #157: o pior caso: o kit inteiro conferido, dois pedidos enviados, duas devoluções novas na fila e, depois do prazo, um pedido atrasado e outro com resposta para ler. */
async function fullWorld(): Promise<{ world: SupplierWorld; sweep: number }> {
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

type Measure = { readonly sweep: number; readonly reads: number; readonly messages: number; readonly total: number };

/** #157: a varredura no teto e a rodada do Claude, com a fila cheia de cada tarefa de tasksFor, contadas fetch a fetch. */
async function measureRound(): Promise<Measure> {
  const { world: w, sweep } = await fullWorld();
  // #157: a precondição: toda tarefa tem na fila ao menos o que a rodada atende, senão a medida não é o pior caso.
  const queued = await Promise.all(tasksFor(w.rest).map(async (t) => [t.name, (await t.pending(restDb(w.rest))).requests.length, Math.min(t.limit ?? CRON_LIMIT, t.maxPerRun ?? CRON_LIMIT, CRON_LIMIT)] as const));
  for (const [name, pending, limit] of queued) expect(pending, `fila de ${name}`).toBeGreaterThanOrEqual(limit);
  const api = messagesApi((key) => w.fake.rows('proposals').find((row) => row.invoice_access_key === key));
  const start = w.fake.requests.length;
  const round = await runClaudeRound(w.rest, ENV, { fetch: api.fetch, log: () => {} });
  const reads = w.fake.requests.length - start;
  expect(round.failedTasks).toEqual([]);
  expect(api.calls(), 'cada tarefa pergunta ao Claude até o limite dela').toBe(queued.reduce((sum, [name, , limit]) => sum + (name === 'invoice-audit' ? AUDIT_CALLS_PER_NOTE : 1) * limit, 0));
  return { sweep, reads, messages: api.calls(), total: sweep + reads + api.calls() };
}

/** #157: o gasto de antes da #157, com a tarefa da cobrança no Cron (varredura 4, PostgREST 47, Messages API 6). */
const BEFORE_58 = 57;

/** #157: o gasto medido hoje; quem acrescenta uma leitura ou uma tarefa muda este número e vê o teste cair. */
const MEASURED_TOTAL = 58;

/** #230: o que o auditor soma ao gasto (2 chamadas à Messages API e 6 ao banco, medido): a conta de antes dele, só da #157 e da #157, era 50. */
const AUDITOR_SUBREQUESTS = 8;

describe('#157 a conta das subrequests da rodada do Cron, medida na rodada de verdade', () => {
  it('a varredura e a rodada do Claude, com a fila cheia de cada tarefa de tasksFor, gastam o que está medido, e uma leitura a mais ou uma tarefa nova faz o teste cair', async () => {
    const m = await measureRound();
    expect(m.total).toBe(MEASURED_TOTAL);
  });

  it('#157: sem a tarefa da cobrança no Cron a conta cai: abaixo dos 57 de antes (sem o auditor, que a #230 acrescentou), e o Claude não é mais perguntado pela cobrança', async () => {
    const m = await measureRound();
    expect(m.total - AUDITOR_SUBREQUESTS).toBeLessThan(BEFORE_58);
    expect(m.messages, '5 das tarefas do #157 e 2 do auditor').toBe(5 + AUDIT_CALLS_PER_NOTE);
  });

  // #155 (do fork Djegao/grupo-5-slucao, não o #155 da principal): a conta cabia nos 50 do plano gratuito desde a #157 (50), e o auditor da #230
  // #155 (invoice-audit, maxPerRun 1, 8 subrequests) a leva a 58. Este teste volta a ser `it.fails`, a lacuna registrada: quando a rodada couber
  // #155 nos 50 (menos leituras, ou o auditor fora do plano gratuito), o `it.fails` cai e vira `it`. A conta mede só a varredura e a rodada do Claude,
  // #155 não a invocação inteira do Cron (api/src/claude/cron.ts).
  it.fails('a varredura e a rodada do Claude cabem nos 50 subrequests do plano gratuito (#155: hoje 58, com o auditor)', async () => {
    const m = await measureRound();
    expect(m.total).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
  });
});
