// #362 A captura lê em lote e só trabalha nas notas novas ou a conferir: a rodada quieta não gasta por nota, e o gasto não cresce com o número de notas.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { startRoundMeter } from '../../src/cron/round-meter.js';
import { buildRoundSteps } from '../../src/cron/round-steps.js';
import { supabaseRoundWork } from '../../src/cron/round-work.js';
import { tick } from '../../src/cron/tick.js';
import type { Env } from '../../src/env.js';
import { fakeAi } from '../support/fake-ai.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const URL_ = 'https://fake.supabase.co';
type Row = Record<string, unknown>;
const copyKey = (key: string, n: number) => `${key.slice(0, -4)}${String(1000 + n)}`;

/** #362 As notas do kit (80) e, acima disso, cópias delas com chave nova e os mesmos itens: `count` notas na SEFAZ. */
function sefazWith(count: number): Record<string, Row[]> {
  const tables = kitTables();
  const invoiceRows = tables.kit_notas ?? [];
  const itens = tables.kit_nota_itens ?? [];
  for (let n = 0; invoiceRows.length < count; n += 1) {
    const original = invoiceRows[n % 80];
    if (!original) throw new Error('o kit não tem notas');
    const key = copyKey(String(original.chave), n);
    invoiceRows.push({ ...original, chave: key });
    for (const item of itens.filter((i) => i.chave === original.chave)) itens.push({ ...item, chave: key });
  }
  return tables;
}

/** #362 Um mundo quieto: as `count` notas já capturadas e já decididas (nada a conferir, nada a propor), nada novo na SEFAZ. */
function quietWorld(count: number, settle = true, demo = false): FakePostgrest {
  const tables = sefazWith(count);
  const stored = settle ? (tables.kit_notas ?? []).map((n) => ({ access_key: n.chave, state: 'decidida', check_error: null })) : [];
  const demoSettings = demo ? [{ id: true, enabled: true, changed_by: null, changed_at: '2026-11-23T09:00:00+00:00', version: 1, history: [] }] : [];
  return new FakePostgrest({ ...tables, invoices: stored, engine_settings: [], claude_suggestions: [], demo_settings: demoSettings });
}

const ENV: Env = {
  BARTE_ACADEMY_SUPABASE_URL: URL_,
  BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake',
  ai: fakeAi(async () => ({ response: { outcome: 'approve', confidence: 0.99, reason: 'fecha' } })),
};

/** #362 A rodada real pelo tick, `rounds` vezes; devolve o gasto medido de cada uma (o gravado mais a soltura da trava) e as linhas gravadas. */
async function tickRounds(fake: FakePostgrest, rounds: number): Promise<{ spend: number[]; runs: Row[] }> {
  // #349 O fake não implementa a rpc do lote das notas demo: com o modo ligado ela responde 0 (o lote já existia, nenhuma nota entrou), contada como subrequest igual.
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => 
    String(input).includes('/rpc/kit_insert_demo_batch') ? Promise.resolve(new Response('0', { status: 200, headers: { 'content-type': 'application/json' } }))
      // #363 As filas das rpcs da contagem da doca e das respostas da demonstração: vazias, uma leitura cada.
      : /\/rpc\/demo_(dock_count|supplier_replies)_pending/.test(String(input)) ? Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
      : fake.fetch(String(input), init));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const spend: number[] = [];
  for (let i = 0; i < rounds; i += 1) {
    await tick({ cron: '* * * * *' }, ENV);
    spend.push(Number(fake.rows('automation_runs').at(-1)?.subrequests) + 1);
  }
  return { spend, runs: fake.rows('automation_runs') };
}

/** #362 A captura sozinha, fetch a fetch, com o medidor da rodada e o fetch do medidor no rest. */
async function captureOnly(fake: FakePostgrest): Promise<{ spent: number; requests: string[] }> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const meter = startRoundMeter(ENV, { measureOnly: true, fetch: (input, init) => fake.fetch(input, init) });
  const rest = new SupabaseRest({ url: URL_, secretKey: 'sb_secret_fake', fetch: meter.fetch, memoizeReads: true });
  const step = buildRoundSteps(supabaseRoundWork(rest, meter.env, meter.fetch)).steps.find((s) => s.name === 'captura');
  if (!step) throw new Error('sem o passo captura');
  const since = fake.requests.length;
  await step.run();
  return { spent: meter.spent(), requests: fake.requests.slice(since).map((r) => `${r.method} ${r.url.replace(`${URL_}/rest/v1/`, '').split('?')[0]}`) };
}

describe('#362/AC-1 a rodada quieta com 80 notas já capturadas cabe com folga no teto', () => { // ADR-002
  it('#362/AC-1 a rodada inteira gasta menos de 20 dos 50 subrequests e termina com failed_steps vazio', async () => { // ADR-002
    const { spend, runs } = await tickRounds(quietWorld(80), 6);
    expect(Math.max(...spend), `gasto por rodada: ${spend.join(', ')}`).toBeLessThan(20);
    expect(runs.every((r) => r.status === 'ok' && (r.failed_steps as string[]).length === 0), JSON.stringify(runs.map((r) => r.failed_steps))).toBe(true);
  });
});

describe('#362/AC-1 e #349 a rodada quieta com o modo demonstração ligado, o passo notas-demo antes da captura', () => { // ADR-002
  it('#362/AC-1 com o modo ligado, a rodada quieta gasta menos de 22 dos 50, igual com 80 e com 200 notas, e failed_steps vazio', async () => { // ADR-002
    const w = quietWorld(80, true, true);
    const a = await tickRounds(w, 6);
    const b = await tickRounds(quietWorld(200, true, true), 6);
    for (const r of [a, b]) {
      expect(r.runs.every((run) => run.demo_enabled === true), 'o modo está ligado').toBe(true);
      expect(r.runs.every((run) => run.status === 'ok' && (run.failed_steps as string[]).length === 0), JSON.stringify(r.runs.map((run) => run.failed_steps))).toBe(true);
      expect(Math.max(...r.spend), `gasto por rodada: ${r.spend.join(', ')}`).toBeLessThan(22); // #363 com o modo ligado entram duas leituras de fila vazia (contagem da doca e respostas do fornecedor)
    }
    expect(b.spend).toEqual(a.spend);
  });
});

describe('#362/AC-2 o gasto da captura não cresce com o número de notas', () => { // ADR-002
  it('#362/AC-2 a captura quieta gasta o mesmo com 80 e com 200 notas, e só 2 leituras: as chaves da SEFAZ e as notas guardadas', async () => { // ADR-002
    const with80 = await captureOnly(quietWorld(80));
    const with200 = await captureOnly(quietWorld(200));
    expect(with200.spent).toBe(with80.spent);
    expect(with80.spent).toBeLessThanOrEqual(2);
  });

  it('#362/AC-2 a captura quieta não lê os itens, não relê o que não mudou e não grava nenhuma nota', async () => { // ADR-002
    for (const count of [80, 200]) {
      const { requests } = await captureOnly(quietWorld(count));
      expect(requests.filter((r) => r.startsWith('POST') || r.includes('kit_nota_itens') || r.includes('claude_suggestions')), `com ${count} notas`).toEqual([]);
    }
  });

  it('#362/AC-2 a rodada quieta inteira gasta o mesmo com 80 e com 200 notas', async () => { // ADR-002
    const a = await tickRounds(quietWorld(80), 4);
    const b = await tickRounds(quietWorld(200), 4);
    expect(b.spend).toEqual(a.spend);
  });
});

describe('#362/AC-3 notas novas ou a conferir: só elas são gravadas, conferidas e propostas', () => { // ADR-002
  /** #362 Três notas novas na SEFAZ de um mundo quieto de 77: as três últimas ainda não foram capturadas. */
  function withThreeNew(): FakePostgrest {
    const fake = quietWorld(80);
    const invoices = fake.rows('invoices');
    invoices.splice(invoices.length - 3, 3);
    return fake;
  }

  it('#362/AC-3 grava só as 3 novas, confere só elas e a captura gasta o mesmo de uma rodada com trabalho, qualquer que seja o resto', async () => { // ADR-002
    const fake = withThreeNew();
    const { spent } = await captureOnly(fake);
    const posts = fake.requests.filter((r) => r.method === 'POST' && r.url.includes('/invoices'));
    expect(posts.flatMap((p) => p.body as Row[]).map((r) => r.access_key)).toHaveLength(6); // #362 AC-3 3 gravadas e 3 conferidas, nenhuma das 77
    expect(new Set(posts.flatMap((p) => p.body as Row[]).map((r) => r.access_key)).size).toBe(3);
    expect(fake.rows('invoices').filter((r) => r.state === 'conferida')).toHaveLength(3);
    expect(spent).toBeLessThanOrEqual(18);
  });

  it('#362/AC-3 a nota a conferir (guardada e ainda a conferir) é conferida de novo, e a conferida e decidida fica como está', async () => { // ADR-002
    const fake = quietWorld(80);
    const first = fake.rows('invoices')[0];
    if (!first) throw new Error('sem nota guardada');
    first.state = 'a_conferir';
    await captureOnly(fake);
    expect(fake.rows('invoices').filter((r) => r.state === 'conferida').map((r) => r.access_key)).toEqual([first.access_key]);
    expect(fake.rows('invoices').filter((r) => r.state === 'decidida')).toHaveLength(79);
  });

  it('#362/AC-3 o resultado da conferência das notas novas é o de capturar tudo de uma vez (E6 compara com as já capturadas)', async () => { // ADR-002
    const all = quietWorld(80, false);
    await captureOnly(all);
    const partial = withThreeNew();
    const gone = partial.rows('invoices').length;
    expect(gone).toBe(77);
    await captureOnly(partial);
    const classOf = (fake: FakePostgrest, key: unknown) => fake.rows('invoices').find((r) => r.access_key === key)?.classification;
    for (const invoiceRow of (partial.rows('kit_notas') ?? []).slice(-3)) expect(classOf(partial, invoiceRow.chave)).toBe(classOf(all, invoiceRow.chave));
    expect(partial.rows('divergences').length).toBeLessThanOrEqual(all.rows('divergences').length);
  });
});
