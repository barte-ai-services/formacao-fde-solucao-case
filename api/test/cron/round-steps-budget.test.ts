// #356 AC-4 O orçamento medido da rodada: o custo de cada passo da lista (cron/round-steps.ts), medido fetch a fetch
// #356 AC-4 com a fila cheia dele (no teto dos passos com laço), pelo método de test/claude/budget.test.ts, a rodada
// #356 AC-4 mais cheia inteira, com os passos do Claude, contra o teto de 50, e a cadência com a fila vazia e com a cheia.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STEP_BUDGET, executeRound, planRound, type RoundStep } from '../../src/automation/round-budget.js';
import { runRound, type RoundPorts, type RoundRecord } from '../../src/automation/round.js';
import { runClaudeRound } from '../../src/claude/cron.js';
import { tasksFor } from '../../src/claude/tasks/index.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { SUBREQUEST_CAP } from '../../src/cron/subrequests.js';
import { startRoundMeter, type RoundMeter } from '../../src/cron/round-meter.js';
import { PROPOSALS_PER_STEP, REGISTRY_MESSAGES_PER_STEP, supabaseRoundWork } from '../../src/cron/round-work.js';
import { buildRoundSteps, CLAUDE_TASK_COSTS, REGISTRY_SLICES, STEP_COSTS } from '../../src/cron/round-steps.js';
import { tick } from '../../src/cron/tick.js';
import { sweepSupplierOverdue } from '../../src/cron/supplier-sweep.js';
import type { Env } from '../../src/env.js';
import { decide, returnFirstItem } from '../returns/supabase-decided-source.support.js';
import { ENV as CLAUDE_ENV, fullWorld, messagesApi, messagesBody } from '../support/budget-world.js';
import { fakeAi } from '../support/fake-ai.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { AFTER_DUE } from '../support/reply-scenarios.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const URL_ = 'https://fake.supabase.co';
const ANSWER = { summary: 'ok', divergences: [], supplier_history: 'ok' };
const ENGINE_ON = [{ level: 'analista', delegation_enabled: true, confidence_threshold: 0.98, clef_timeout_ms: 8000 }];
const names = (steps: readonly RoundStep[]) => steps.map((s) => s.name);

/** #356 AC-4 Uma subrequest de porta (modo, trava, adiados, gravar, soltar): passa pelo mesmo medidor, e o fetch falso a atende. */
const PORT_URL = 'https://portas.test/';
const ANTHROPIC = 'https://api.anthropic.com/';

/**
 * #356 AC-4 O mundo do kit: o PostgREST falso, a Messages API do Claude e o Workers AI, tudo contado por UM medidor por
 * rodada (cada chamada é uma subrequest, o contador da #311), como a camada API vai montar: o `rest` e o Claude recebem o fetch do
 * medidor e o motor o env dele. `begin` abre a rodada (um medidor novo); `measuring` tira o teto e o corte de tempo, para medir passos soltos.
 */
function kitWorld(delegation = true, tweak: (tables: ReturnType<typeof kitTables>) => void = () => {}) {
  const tables = kitTables();
  tweak(tables);
  const fake = new FakePostgrest({ ...tables, engine_settings: ENGINE_ON.map((s) => ({ ...s, delegation_enabled: delegation })), claude_suggestions: [] });
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(PORT_URL)) return Promise.resolve(new Response('{}', { status: 200 }));
    if (!url.startsWith(ANTHROPIC)) return fake.fetch(url, init);
    return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'responder', input: ANSWER }] }), { status: 200 }));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const env: Env = {
    BARTE_ACADEMY_SUPABASE_URL: URL_,
    BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake',
    BARTE_ACADEMY_ANTHROPIC_API_KEY: 'chave-de-teste',
    ai: fakeAi(async () => ({ response: { outcome: 'approve', confidence: 0.99, reason: 'fecha' } })),
  };
  return roundWorld(fake, env);
}

/** #356 AC-4 O que o kitWorld e a rodada mais cheia têm em comum: o medidor da rodada e o que se monta com ele. */
function roundWorld(fake: FakePostgrest, env: Env) {
  let meter: RoundMeter = startRoundMeter(env);
  let rest = new SupabaseRest({ url: URL_, secretKey: 'sb_secret_fake', fetch: meter.fetch, memoizeReads: true });
  const begin = (measuring = false) => {
    meter = startRoundMeter(env, measuring ? { measureOnly: true } : {});
    rest = new SupabaseRest({ url: URL_, secretKey: 'sb_secret_fake', fetch: meter.fetch, memoizeReads: true });
  };
  begin(true);
  const spent = () => meter.spent();
  const build = () => buildRoundSteps(supabaseRoundWork(rest, meter.env, meter.fetch));
  /** #356 AC-4 Roda um passo e devolve o que gastou. */
  const measure = async (step: RoundStep): Promise<number> => {
    // #362 O custo declarado é o do passo SOZINHO: o que um passo de antes leu e a rodada guardou (a foto da rodada) não entra na conta dele.
    rest.resetReads();
    const before = spent();
    await step.run();
    return spent() - before;
  };
  /** #356 AC-4 A pessoa (ou a regra) decide tudo o que espera, no dia dado: a fila cheia da doca, da loja, das devoluções e do E8. */
  const decideAll = (decidedOn: string) => {
    for (const p of fake.rows('proposals').filter((r) => r.state === 'aguardando_aprovacao')) {
      decide(fake, p, { state: 'aprovada', action: returnFirstItem(fake, p), decidedOn });
    }
  };
  return {
    fake, env, build, measure, spent, refused: () => meter.refused(), decideAll, begin,
    hit: () => meter.fetch(`${PORT_URL}porta`),
    hitReserved: () => meter.reservedFetch(`${PORT_URL}porta`),
  };
}

const dayUtc = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const stepNamed = (steps: readonly RoundStep[], name: string): RoundStep => {
  const step = steps.find((s) => s.name === name);
  if (!step) throw new Error(`sem o passo ${name}`);
  return step;
};

/** #356 AC-4 O teto de notas por passo deixa notas conferidas para trás: o passo roda de novo até todas as 80 do kit terem proposta. */
async function proposeAll(w: ReturnType<typeof kitWorld>, steps: readonly RoundStep[]): Promise<void> {
  const propose = stepNamed(steps, 'propostas');
  for (let i = 0; i < 5 && w.fake.rows('proposals').length < w.fake.rows('invoices').length; i += 1) await w.measure(propose);
}

/** #356 AC-4 Mede cada passo do kit na rodada 1 (tudo novo: captura, proposta, motor) e na 2 (tudo decidido: doca, loja, devoluções). */
async function measureKit(): Promise<Map<string, number>> {
  const worst = new Map<string, number>();
  // #356 AC-4 O motor, com a delegação ligada (aprova) e desligada (a sombra): vale o mais caro dos dois.
  for (const delegation of [true, false]) {
    const w = kitWorld(delegation);
    const note = (name: string, cost: number) => worst.set(name, Math.max(worst.get(name) ?? 0, cost));
    const first = w.build();
    for (const s of first.steps) if (!s.name.startsWith('claude-') && s.name !== 'prazo-fornecedor') note(s.name, await w.measure(s));
    await proposeAll(w, first.steps);
    w.decideAll(dayUtc(0));
    const second = w.build();
    for (const s of second.steps) if (!s.name.startsWith('claude-') && s.name !== 'prazo-fornecedor') note(s.name, await w.measure(s));
  }
  return worst;
}

/** #356 AC-4 O E8 de cada fatia da janela, com as decisões do kit caindo dentro dela. */
async function measureRegistrySlices(): Promise<number[]> {
  const out: number[] = [];
  for (const [from] of REGISTRY_SLICES) {
    const w = kitWorld();
    const first = w.build();
    for (const name of ['captura', 'propostas']) await w.measure(stepNamed(first.steps, name));
    await proposeAll(w, first.steps);
    w.decideAll(dayUtc(from));
    const slice = REGISTRY_SLICES.findIndex(([f]) => f === from);
    const second = w.build();
    out.push(await w.measure(stepNamed(second.steps, second.steps.filter((s) => s.name.startsWith('cadastro-e8'))[slice]?.name ?? '')));
  }
  return out;
}

describe('#356/AC-4 o custo de cada passo, medido com a fila cheia', () => { // ADR-002
  it('os passos do kit declaram o que se mediu, e uma leitura a mais ou um passo novo faz o teste cair', async () => { // ADR-002
    const measured = await measureKit();
    const byName = (name: string) => measured.get(name);
    expect({
      capture: byName('captura'),
      unreconciled: byName('recebimentos-sem-nota'),
      propose: byName('propostas'),
      dock: byName('doca'),
      store: byName('loja'),
      returns: byName('devolucoes'),
      engine: byName('motor'),
    }).toEqual({
      capture: STEP_COSTS.capture,
      unreconciled: STEP_COSTS.unreconciled,
      propose: STEP_COSTS.propose,
      dock: STEP_COSTS.dock,
      store: STEP_COSTS.store,
      returns: STEP_COSTS.returns,
      engine: STEP_COSTS.engine,
    });
  });

  it('o E8 de cada fatia da janela de 7 dias não gasta mais que o declarado, com as decisões do kit dentro da fatia', async () => { // ADR-002
    const slices = await measureRegistrySlices();
    expect(Math.max(...slices)).toBeLessThanOrEqual(STEP_COSTS.registry);
  });

  it('o prazo do fornecedor declara o que a varredura mede com a fila cheia (#157)', async () => { // ADR-002
    const { world: w } = await fullWorld();
    w.setNow(AFTER_DUE);
    const before = w.fake.requests.length;
    await sweepSupplierOverdue(w.rest, { now: () => AFTER_DUE });
    expect(w.fake.requests.length - before).toBe(STEP_COSTS.supplierOverdue);
  });

  it('cada tarefa do Claude, com a fila cheia dela, declara o que mede (PostgREST e Messages API)', async () => { // ADR-002
    const { world: w } = await fullWorld();
    const measured: Record<string, number> = {};
    for (const task of tasksFor(w.rest)) {
      const api = messagesApi((key) => w.fake.rows('proposals').find((row) => row.invoice_access_key === key));
      const start = w.fake.requests.length;
      await runClaudeRound(w.rest, CLAUDE_ENV, { fetch: api.fetch, log: () => {}, only: [task.name] });
      measured[task.name] = w.fake.requests.length - start + api.calls();
    }
    expect(measured).toEqual(CLAUDE_TASK_COSTS);
  });
});

describe('#356/AC-4 a lista cabe no orçamento', () => { // ADR-002
  it('todo passo cabe sozinho ao lado da captura, o que o planRound exige para não haver fome', () => { // ADR-002
    const build = kitWorld().build();
    const capture = stepNamed(build.steps, 'captura');
    expect(capture.critical).toBe(true);
    for (const s of build.steps) {
      expect(s.maxSubrequests, s.name).toBeLessThanOrEqual(STEP_BUDGET - (s.critical ? 0 : capture.maxSubrequests));
    }
  });

  it('a lista mantém a ordem de hoje: captura (e as marcas de falha dela), recebimentos, propostas, E8, doca, loja, devoluções, duplicados, prazo, Claude, motor', () => { // ADR-002
    const order = names(kitWorld().build().steps).map((n) => n.replace(/^cadastro-e8.*/, 'cadastro-e8').replace(/^claude-.*/, 'claude'));
    expect([...new Set(order)]).toEqual([
      'captura', 'marcas-da-conferencia', 'recebimentos-sem-nota', 'propostas', 'cadastro-e8', 'doca', 'loja', 'devolucoes', 'duplicados',
      'prazo-fornecedor', 'claude', 'motor',
    ]);
  });

  it('o planRound aceita a lista com os custos medidos: a captura e o maior periférico cabem juntos no orçamento', () => { // ADR-002
    const steps = kitWorld().build().steps;
    expect(() => planRound(steps, [])).not.toThrow();
    for (const s of steps) expect(() => planRound(steps, [s.name]), s.name).not.toThrow();
  });

  it('só a captura é do caminho crítico', () => { // ADR-002
    expect(kitWorld().build().steps.filter((s) => s.critical).map((s) => s.name)).toEqual(['captura']);
  });
});

/** #356 AC-4 Uma chave de acesso de 44 dígitos derivada de outra (a cópia de número `n`). */
const copyKey = (key: string, n: number) => `${key.slice(0, -4)}${String(9000 + n)}`;

/** #356 AC-4 Copia as decisões do kit com E8 `copies` vezes, para uma fatia da janela ter bem mais mensagens que o teto. */
function multiplyDecidedE8(fake: FakePostgrest, copies: number): void {
  const e8 = new Set(fake.rows('divergences').filter((d) => d.classification === 'E8').map((d) => String(d.invoice_access_key)));
  const decided = fake.rows('proposals').filter((p) => p.state === 'aprovada' && e8.has(String(p.invoice_access_key)));
  for (let n = 1; n <= copies; n += 1) {
    for (const p of decided) {
      const key = String(p.invoice_access_key);
      const next = copyKey(key, n);
      const id = Number(p.id) + 10_000 * n;
      const again = (table: string, field: string, set: Record<string, unknown>) => {
        for (const row of fake.rows(table).filter((r) => r[field] === (field === 'proposal_id' ? p.id : key))) fake.rows(table).push({ ...row, ...set });
      };
      again('invoices', 'access_key', { access_key: next });
      again('divergences', 'invoice_access_key', { invoice_access_key: next });
      again('titles', 'invoice_access_key', { invoice_access_key: next });
      again('approvals', 'proposal_id', { proposal_id: id, id: 1000 + id });
      fake.rows('proposals').push({ ...p, id, invoice_access_key: next });
    }
  }
}

describe('#356/AC-4 os passos com laço, medidos no teto', () => { // ADR-002
  it('as propostas: com mais notas conferidas que o teto, o passo propõe o teto e gasta o declarado', async () => { // ADR-002
    const w = kitWorld();
    const { steps } = w.build();
    await w.measure(stepNamed(steps, 'captura'));
    const cost = await w.measure(stepNamed(steps, 'propostas'));
    expect(w.fake.rows('proposals')).toHaveLength(PROPOSALS_PER_STEP);
    expect(cost).toBe(STEP_COSTS.propose);
  });

  it('os duplicados: com mais títulos lançados que o teto, gasta 2 leituras mais um update por título do teto, o declarado', async () => { // ADR-002
    const w = kitWorld();
    const { steps } = w.build();
    for (const name of ['captura', 'propostas']) await w.measure(stepNamed(steps, name));
    const extra = Array.from({ length: 11 }, (_, i) => copyKey('35261194433432000143550010000894281178831290', i + 1));
    w.fake.rows('invoices').push(...extra.map((access_key) => ({ access_key, classification: 'E6' })));
    w.fake.rows('titles').push(...extra.map((invoice_access_key) => ({ invoice_access_key, amount_cents: 100, due_on: '2026-11-20', state: 'lancado', updated_at: null })));
    expect(await w.measure(stepNamed(steps, 'duplicados'))).toBe(STEP_COSTS.duplicates);
    expect(w.fake.rows('titles').filter((t) => t.state === 'lancado').length, 'o que passou do teto fica para o passo seguinte').toBeGreaterThan(0);
  });

  it('o E8: com três vezes as mensagens do kit na fatia, publica só o teto de novas por passo e gasta o declarado, e as passadas não prendem as de trás', async () => { // ADR-002
    const w = kitWorld();
    const { steps } = w.build();
    for (const name of ['captura', 'propostas']) await w.measure(stepNamed(steps, name));
    await proposeAll(w, steps);
    w.decideAll(dayUtc(0));
    multiplyDecidedE8(w.fake, 2);
    const slice = stepNamed(steps, 'cadastro-e8-dias-0-1');
    const costs: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      costs.push(await w.measure(slice));
      expect(w.fake.rows('outbox_registry_corrections').length).toBeLessThanOrEqual(REGISTRY_MESSAGES_PER_STEP * (i + 1));
    }
    expect(w.fake.rows('outbox_registry_corrections'), 'três passos publicam as 27 mensagens, sem prender as de trás').toHaveLength(27);
    expect(Math.max(...costs)).toBe(STEP_COSTS.registry);
    expect(costs.at(-1), 'sem nada novo, o passo só lê').toBeLessThan(STEP_COSTS.registry);
  });

  it('as marcas de falha da conferência: com mais notas quebradas que o teto, marca o teto e gasta o declarado', async () => { // ADR-002
    const w = kitWorld(true, (tables) => {
      for (const nota of tables.kit_notas ?? []) nota.data_emissao = '09/11/2026';
    });
    const { steps } = w.build();
    await w.measure(stepNamed(steps, 'captura'));
    expect(await w.measure(stepNamed(steps, 'marcas-da-conferencia'))).toBe(STEP_COSTS.checkFailures);
    expect(w.fake.rows('invoices').filter((r) => r.check_error)).toHaveLength(STEP_COSTS.checkFailures);
  });

  it('as marcas de falha com nenhuma nota quebrada não gastam nada', async () => { // ADR-002
    const w = kitWorld();
    const { steps } = w.build();
    await w.measure(stepNamed(steps, 'captura'));
    expect(await w.measure(stepNamed(steps, 'marcas-da-conferencia'))).toBe(0);
  });
});

/** #356 AC-4 Os dublês das portas em memória; cada chamada a uma porta é uma subrequest do mesmo medidor da rodada. */
function countedPorts(world: ReturnType<typeof roundWorld>) {
  const records: RoundRecord[] = [];
  const logs: string[] = [];
  let owner: string | null = null;
  let deferred: readonly string[] = [];
  const ports: RoundPorts = {
    mode: { read: async () => { await world.hit(); return { enabled: true, changedAt: null }; }, write: async () => { await world.hit(); } },
    lock: {
      take: async (o) => { await world.hit(); if (owner) return false; owner = o; return true; },
      release: async (o) => { await world.hitReserved(); if (owner === o) owner = null; },
    },
    history: {
      lastDeferred: async () => { await world.hit(); return deferred; },
      record: async (r) => { await world.hitReserved(); records.push(r); if (r.status !== 'skipped') deferred = r.deferredSteps; },
    },
    buildRound: world.build,
    spent: world.spent,
    refused: world.refused,
    newOwner: () => 'dono',
    now: () => new Date(),
    log: (line) => void logs.push(line),
  };
  return { ports, records, logs };
}

/** #356 AC-4 Uma rodada inteira, com o medidor novo dela; devolve o gasto medido. */
async function playRound(world: ReturnType<typeof roundWorld>, ports: RoundPorts): Promise<number> {
  world.begin();
  expect((await runRound(ports, { origin: 'manual' })).kind).toBe('done');
  return world.spent();
}

/**
 * #356 AC-4 A rodada mais cheia: o kit e o mundo do fornecedor (os pedidos enviados, a resposta a ler, as devoluções na
 * fila) com a Messages API falsa e o Workers AI contados, e os passos do Claude e o prazo do fornecedor incluídos.
 */
async function fullestWorld(demo = false) {
  const { world: w } = await fullWorld();
  w.fake.tables.set('engine_settings', ENGINE_ON.map((s) => ({ ...s })));
  // #349 Com o modo demonstração ligado o passo notas-demo entra na rodada; o fake não tem a rpc do lote, que responde 0 (nenhuma nota entrou), contada igual.
  if (demo) w.fake.tables.set('demo_settings', [{ id: true, enabled: true, changed_by: null, changed_at: '2026-11-23T09:00:00+00:00', version: 1, history: [] }]);
  const api = messagesApi((key) => w.fake.rows('proposals').find((row) => row.invoice_access_key === key));
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(PORT_URL)) return Promise.resolve(new Response('{}', { status: 200 }));
    if (url.includes('/rpc/kit_insert_demo_batch')) return Promise.resolve(new Response('0', { status: 200, headers: { 'content-type': 'application/json' } }));
    if (!url.startsWith(ANTHROPIC)) return w.fake.fetch(url, init);
    const body = messagesBody(init);
    if (Object.keys(body.tools[0]?.input_schema.properties ?? {}).includes('summary')) {
      return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'responder', input: ANSWER }] }), { status: 200 }));
    }
    return api.fetch(String(input), init);
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AFTER_DUE);
  const env: Env = {
    BARTE_ACADEMY_SUPABASE_URL: URL_,
    BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake',
    BARTE_ACADEMY_ANTHROPIC_API_KEY: CLAUDE_ENV.BARTE_ACADEMY_ANTHROPIC_API_KEY,
    ai: fakeAi(async () => ({ response: { outcome: 'approve', confidence: 0.99, reason: 'fecha' } })),
  };
  const world = roundWorld(w.fake, env);
  return { ...world, decideAll: () => world.decideAll(AFTER_DUE.toISOString().slice(0, 10)) };
}

/** #356 AC-4 O gasto medido da rodada mais cheia (os passos e as 5 chamadas às portas, fetch a fetch), com os passos do Claude e o prazo do fornecedor, contra o teto de 50 (SUBREQUEST_CAP, o da #311). Quem acrescenta um passo ou uma leitura muda este número e vê o teste cair. */
const FULLEST_ROUND_MEASURED = 48;

/** #356 AC-4 O mínimo de rodadas que a lista cheia leva para passar por todos os passos, com os custos declarados. */
const ROUNDS = 14;

describe('#356/AC-4 a rodada mais cheia contra o teto de 50', () => { // ADR-002
  it('com a fila cheia de cada passo (e os do Claude e o prazo do fornecedor), o gasto medido não passa de 50, e todo passo adiado roda numa rodada seguinte', async () => { // ADR-002
    const world = await fullestWorld();
    const { ports, records, logs } = countedPorts(world);
    const roundSpend: number[] = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      if (i === 1) world.decideAll();
      roundSpend.push(await playRound(world, ports));
    }
    // #356 AC-4 nenhuma rodada perdeu a linha nem a trava, e nenhum passo gastou mais que o declarado
    expect(records.every((r) => r.status === 'ok')).toBe(true);
    expect(logs.filter((l) => l.includes('falhou') || l.includes('corrija o custo declarado'))).toEqual([]);
    expect(Math.max(...roundSpend), `gasto por rodada: ${roundSpend.join(', ')}`).toBe(FULLEST_ROUND_MEASURED);
    expect(FULLEST_ROUND_MEASURED).toBeLessThanOrEqual(SUBREQUEST_CAP);
    // #311 A reserva que sobra com a rodada mais cheia: 2 subrequests, e o reenvio da gravação sem as colunas novas (PGRST204) gasta 1 deles.
    expect(SUBREQUEST_CAP - FULLEST_ROUND_MEASURED).toBe(2);
    expect(FULLEST_ROUND_MEASURED + 1).toBeLessThanOrEqual(SUBREQUEST_CAP);
    expect(records[0]?.deferredSteps.length, 'a rodada cheia adia passos').toBeGreaterThan(0);
    // #356 AC-4 sem fome: cada passo da lista, os do Claude e o prazo do fornecedor entre eles, roda em alguma das rodadas.
    const every = names(world.build().steps);
    expect(every.filter((n) => n.startsWith('claude-')).length).toBeGreaterThan(0);
    for (const name of every) {
      expect(records.some((r) => !r.deferredSteps.includes(name)), `${name} nunca rodou`).toBe(true);
    }
  });
});

/**
 * #356 AC-4 O gasto medido da rodada mais cheia com a rodada LIGADA AO TICK (as portas reais sobre o SupabaseRest, um medidor por
 * invocação): o que o `subrequests` gravado diz (o medido, a gravação incluída) mais a soltura da trava, que vem depois dela.
 * Quem acrescenta um passo, uma leitura ou uma porta muda este número e vê o teste cair.
 */
const FULLEST_TICK_MEASURED = 45;

describe('#356/AC-4 a rodada mais cheia, ligada ao tick, contra o teto de 50', () => { // ADR-002
  it('o gasto medido de cada rodada do tick (modo, trava, adiados, passos, gravação e soltura) não passa de 50, e nenhum passo falha', async () => { // ADR-002
    const world = await fullestWorld();
    const tickRound = () => tick({ cron: '* * * * *' }, world.env);
    const spend: number[] = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      if (i === 1) world.decideAll();
      await tickRound();
      // #356 a gravação conta a si mesma (spent + 1); a soltura da trava, depois dela, é a subrequest que falta
      spend.push(Number(world.fake.rows('automation_runs').at(-1)?.subrequests) + 1);
    }
    const runs = world.fake.rows('automation_runs');
    expect(runs.every((r) => r.status === 'ok' && (r.failed_steps as string[]).length === 0), JSON.stringify(runs.map((r) => r.failed_steps))).toBe(true);
    expect(world.fake.rows('automation_lock')).toEqual([]);
    expect(Math.max(...spend), `gasto por rodada: ${spend.join(', ')}`).toBe(FULLEST_TICK_MEASURED);
    expect(FULLEST_TICK_MEASURED).toBeLessThanOrEqual(SUBREQUEST_CAP);
    expect((runs[0]?.deferred_steps as string[]).length, 'a rodada cheia adia passos').toBeGreaterThan(0);
  });
});

/** #349 #362 A mesma rodada mais cheia ao tick com o modo demonstração ligado: o passo notas-demo (custo declarado 2) entra antes da captura e a rodada segue dentro de 50. */
const FULLEST_TICK_DEMO_MEASURED = 45;

describe('#349/AC-4 a rodada mais cheia ao tick com o modo demonstração ligado', () => { // ADR-002
  it('o gasto medido de cada rodada, com o notas-demo à frente da captura, não passa de 50, e nenhum passo falha', async () => { // ADR-002
    const world = await fullestWorld(true);
    const spend: number[] = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      if (i === 1) world.decideAll();
      await tick({ cron: '* * * * *' }, world.env);
      spend.push(Number(world.fake.rows('automation_runs').at(-1)?.subrequests) + 1);
    }
    const runs = world.fake.rows('automation_runs');
    const own = runs.slice(-ROUNDS); // #349 a primeira linha é da semeadura do mundo, de antes do modo ligado
    expect(own.map((r) => [r.status, r.demo_enabled, (r.failed_steps as string[]).length])).toEqual(own.map(() => ['ok', true, 0]));
    expect(world.fake.rows('automation_lock')).toEqual([]);
    expect(Math.max(...spend), `gasto por rodada: ${spend.join(', ')}`).toBe(FULLEST_TICK_DEMO_MEASURED);
    expect(FULLEST_TICK_DEMO_MEASURED).toBeLessThanOrEqual(SUBREQUEST_CAP);
  });
});

/** #356 AC-4 A cadência: a maior espera, em rodadas, entre duas execuções de cada passo, a partir das rodadas gravadas (o adiado conta como não rodou). */
function longestWait(records: readonly RoundRecord[], every: readonly string[]): Record<string, number> {
  return Object.fromEntries(
    every.map((n) => {
      let wait = 0;
      let longest = 0;
      for (const r of records) {
        wait = r.deferredSteps.includes(n) ? wait + 1 : 0;
        longest = Math.max(longest, wait);
      }
      return [n, longest + 1];
    }),
  );
}

describe('#356/AC-4 a cadência medida: adiar o que não coube, não esticar a de quem coube', () => { // ADR-002
  it('com as filas vazias, a rodada gasta até ~40 só lendo as filas, e nenhum passo espera mais de 5 rodadas (com o custo declarado só, eram 10 a 11)', async () => { // ADR-002
    const w = kitWorld(true, (tables) => {
      for (const name of Object.keys(tables)) tables[name] = [];
    });
    const { ports, records } = countedPorts(w);
    const every = names(w.build().steps);
    const spend: number[] = [];
    for (let i = 0; i < 12; i += 1) spend.push(await playRound(w, ports));
    // #356 AC-4 o piso de uma rodada ociosa é ler cada fila uma vez: o gasto real não é baixo, e o que o medidor ganha é só o que o declarado a mais reservava
    expect(Math.max(...spend)).toBeLessThanOrEqual(SUBREQUEST_CAP);
    for (const n of every) expect(longestWait(records, every)[n], `a espera de ${n}`).toBeLessThanOrEqual(5);
    for (const n of ['captura', 'marcas-da-conferencia', 'recebimentos-sem-nota']) expect(longestWait(records, every)[n], n).toBe(1);
  });

  it('com as filas cheias, nenhum passo passa fome: a maior espera entre duas execuções fica abaixo do total de rodadas', async () => { // ADR-002
    const world = await fullestWorld();
    const { ports, records } = countedPorts(world);
    for (let i = 0; i < ROUNDS; i += 1) {
      if (i === 1) world.decideAll();
      await playRound(world, ports);
    }
    const every = names(world.build().steps);
    const waits = longestWait(records, every);
    for (const n of every) expect(waits[n], `a espera de ${n}`).toBeLessThanOrEqual(11);
  });
});

describe('#356/AC-4 um passo adiado roda na rodada seguinte', () => { // ADR-002
  it('o executor adia o que não cabe e o executa na rodada seguinte, com o gasto declarado dentro do orçamento', async () => { // ADR-002
    const ran: string[] = [];
    const mk = (name: string, maxSubrequests: number, critical = false): RoundStep => ({ name, maxSubrequests, ...(critical ? { critical } : {}), run: async () => void ran.push(name) });
    const steps = [mk('captura', 18, true), mk('a', 25), mk('b', 25)];
    const first = await executeRound(steps, []);
    expect(first.deferred).toEqual(['b']);
    expect(first.ran).toEqual(['captura', 'a']);
    const second = await executeRound(steps, first.deferred);
    expect(second.ran).toEqual(['captura', 'b']);
  });
});
