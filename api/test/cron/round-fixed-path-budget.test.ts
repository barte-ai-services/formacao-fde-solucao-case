// #371 O caminho fixo da rodada de 1 minuto, medido: com o modo demonstração ligado, captura, notas-demo, propostas e motor rodam em TODA rodada,
// #371 o custo declarado deles é o medido em sequência (fetch falso contando requisições, o método de test/cron/round-steps-budget.test.ts), os demais
// #371 passos se revezam sem passar de ROTATION_WAIT_MAX rodadas sem vez, e a nota demo que chega tem proposta e decisão do motor em até 2 rodadas.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { startRoundMeter } from '../../src/cron/round-meter.js';
import { supabaseRoundWork } from '../../src/cron/round-work.js';
import { buildRoundSteps, FIXED_PATH, STEP_COSTS } from '../../src/cron/round-steps.js';
import { SUBREQUEST_CAP } from '../../src/cron/subrequests.js';
import { generateDemoBatch } from '../../src/demo/generator.js';
import type { Env } from '../../src/env.js';
import { demoRoundWorld } from '../support/demo-round-world.js';
import { fakeAi } from '../support/fake-ai.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const URL_ = 'https://fake.supabase.co';
const JSON_HEADERS = { 'content-type': 'application/json' };

/** #371 O que o teste mede e prova, como números do cabeçalho do arquivo (o N e como ele saiu estão em round-steps.ts). */
const NOTES_PER_ROUND = 8;
const FIXED_NAMES = ['notas-demo', 'captura', 'propostas', 'motor'];

/**
 * #371 Mede os quatro passos fixos EM SEQUÊNCIA, com a leitura guardada da rodada (`memoizeReads`) valendo de um para o seguinte, como na rodada:
 * o custo de cada um é o que ele gasta depois dos de antes. Rodadas seguidas, com 8 notas novas a cada uma e a fila cheia de propostas a decidir.
 */
async function measureFixedChain(rounds: number, delegation: boolean): Promise<Map<string, number>> {
  const fake = new FakePostgrest({ ...kitTables(), engine_settings: [{ level: 'analista', delegation_enabled: delegation, confidence_threshold: 0.98, clef_timeout_ms: 8000 }], claude_suggestions: [] });
  let sequence = 1;
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('/rpc/kit_insert_demo_batch')) return fake.fetch(url, init);
    const batch = generateDemoBatch({ seed: sequence, count: NOTES_PER_ROUND, now: new Date('2026-11-23T12:00:00Z'), sequenceStart: sequence });
    sequence += NOTES_PER_ROUND;
    for (const [table, rows] of Object.entries(batch.rows)) fake.tables.set(table, [...fake.rows(table), ...(rows as Record<string, unknown>[])]);
    return Promise.resolve(new Response(String(NOTES_PER_ROUND), { status: 200, headers: JSON_HEADERS }));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const env: Env = {
    BARTE_ACADEMY_SUPABASE_URL: URL_,
    BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake',
    ai: fakeAi(async () => ({ response: { outcome: 'approve', confidence: 0.99, reason: 'fecha' } })),
  };
  const worst = new Map<string, number>();
  for (let r = 0; r < rounds; r += 1) {
    const meter = startRoundMeter(env, { measureOnly: true });
    const rest = new SupabaseRest({ url: URL_, secretKey: 'sb_secret_fake', fetch: meter.fetch, memoizeReads: true });
    const { steps } = buildRoundSteps(supabaseRoundWork(rest, meter.env, meter.fetch, { demoMode: async () => true }), Date.now, undefined, true);
    for (const name of FIXED_NAMES) {
      const step = steps.find((s) => s.name === name);
      if (!step) throw new Error(`sem o passo ${name}`);
      const before = meter.spent();
      await step.run();
      worst.set(name, Math.max(worst.get(name) ?? 0, meter.spent() - before));
    }
  }
  return worst;
}

describe('#371/AC-1 o caminho fixo da rodada com o modo demonstração ligado', () => { // ADR-002
  const noWork = async () => 0;
  const work = {
    capture: async () => ({ seen: 0, inserted: 0, checked: 0, failed: 0 }), markCheckFailures: async () => {}, reportUnreconciledReceipts: async () => {},
    propose: async () => ({ proposed: 0, approvedByRule: 0 }), publishRegistry: noWork, publishDock: noWork, publishStore: noWork, publishReturns: noWork,
    blockDuplicates: async () => ({ blocked: 0, failed: 0 }), markOverdueSupplierRequests: noWork, demoDockCount: async () => {}, demoSupplierReplies: async () => {},
    claudeTasks: ['description-match'], claudeTask: async () => {}, engine: async () => ({ evaluated: 0, approved: 0 }), captureDemoNotes: async () => 0, failedSteps: () => [],
  };

  it('ligado, só captura, notas-demo, propostas e motor são fixos; desligado, nenhum', () => { // ADR-002
    const fixedOf = (demo: boolean) => buildRoundSteps(work, Date.now, undefined, demo).steps.filter((s) => s.fixed).map((s) => s.name).sort();
    expect(fixedOf(true)).toEqual([...FIXED_NAMES].sort());
    expect(fixedOf(true)).toEqual([...FIXED_PATH].sort());
    expect(fixedOf(false)).toEqual([]);
  });

  it('a captura segue sendo a única que faz a rodada falhar, e o passo fixo não a faz falhar', () => { // ADR-002
    const build = buildRoundSteps(work, Date.now, undefined, true);
    expect([...build.failsRound]).toEqual(['captura']);
    expect(build.steps.filter((s) => s.critical).map((s) => s.name)).toEqual(['captura']);
  });

  it('o planRound aceita a lista ligada, e os fixos declarados somam no máximo o orçamento dos passos', async () => { // ADR-002
    const { planRound, STEP_BUDGET } = await import('../../src/automation/round-budget.js');
    const steps = buildRoundSteps(work, Date.now, undefined, true).steps;
    expect(() => planRound(steps, [])).not.toThrow();
    const fixedCost = steps.filter((s) => s.fixed).reduce((n, s) => n + s.maxSubrequests, 0);
    expect(fixedCost).toBeLessThanOrEqual(STEP_BUDGET);
  });

  for (const delegation of [false, true]) {
    it(`o custo declarado dos fixos é o medido em sequência, 8 notas por rodada, delegação ${delegation ? 'ligada' : 'desligada'}`, async () => { // ADR-002
      const worst = await measureFixedChain(10, delegation);
      const steps = buildRoundSteps(work, Date.now, undefined, true).steps;
      const declared = (name: string) => steps.find((s) => s.name === name)?.maxSubrequests;
      expect(Object.fromEntries(worst)).toEqual({
        'notas-demo': declared('notas-demo'),
        captura: declared('captura'),
        propostas: declared('propostas'),
        motor: declared('motor'),
      });
      expect(STEP_COSTS.demoNotes).toBe(2);
    });
  }
});

/** #371 O mundo cheio, rodada a rodada, e o que cada uma deixou gravado: as propostas e as decisões do motor até o fim dela. */
async function play(rounds: number, notesPerRound: number, delegation = false) {
  const w = await demoRoundWorld({ notesPerRound, delegation });
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const runs: Record<string, unknown>[] = [];
  const proposed: Set<string>[] = [];
  const decided: Set<string>[] = [];
  for (let i = 0; i < rounds; i += 1) {
    runs.push(await w.round());
    proposed.push(new Set(w.fake.rows('proposals').map((p) => String(p.invoice_access_key))));
    decided.push(new Set(w.fake.rows('engine_decisions').filter((d) => d.mode === 'delegated' && d.role === 'cascade').map((d) => String(d.invoice_access_key))));
  }
  return { w, runs, proposed, decided, logs };
}

/** #371 A maior sequência de rodadas seguidas em que cada passo ficou adiado, mais a rodada em que rodou (a espera entre duas execuções). */
function longestWaits(deferred: readonly (readonly string[])[]): Record<string, number> {
  const waits: Record<string, number> = {};
  for (const name of new Set(deferred.flat())) {
    let wait = 0;
    for (const d of deferred) {
      wait = d.includes(name) ? wait + 1 : 0;
      waits[name] = Math.max(waits[name] ?? 0, wait);
    }
  }
  return waits;
}

const ROUNDS = 30;
/**
 * #371 O N: a espera máxima, em rodadas (em minutos, com o modo ligado), entre duas vezes de um passo que se reveza, MEDIDA em ROUNDS rodadas seguidas
 * com a fila cheia (o mundo mais cheio do kit, com o Claude, o fornecedor e as devoluções) e as notas novas do modo a cada rodada. Cada número é a maior
 * espera medida (a espera de um passo que roda de uma em uma rodada é 0). Com 3 notas por rodada, 9; com 8, o pior caso, 17: quanto mais notas, mais
 * rodadas o motor gasta decidindo (até 4 decisões, 15 do orçamento) e menos sobra aos demais.
 */
const ROTATION_WAIT_MAX: Readonly<Record<number, number>> = { 3: 9, 8: 17 };
/**
 * #371 Os passos que a conta do orçamento deixa de fora do N com o caminho fixo. O fixo gasta 2 + 16 + 7 = 25 antes do motor e o motor ocioso, 7: sobram 11
 * a 13 do orçamento de 43, e o passo que declara mais que isso só cabe numa rodada em que o motor e as propostas gastaram menos que o pior. O rascunho
 * da cobrança (14) não cabe em rodada nenhuma de 3 notas por rodada e, com 8, a ordem provável (12) também não: eles rodam só quando a rodada está leve.
 */
const BEYOND_THE_BUDGET: Readonly<Record<number, readonly string[]>> = { 3: ['claude-supplier-request-draft'], 8: ['claude-supplier-request-draft', 'claude-probable-order'] };

describe('#371/AC-3 várias rodadas seguidas com a fila cheia', () => { // ADR-002
  for (const notes of [3, 8]) {
    it(`com ${notes} notas por rodada o caminho fixo roda em toda rodada, o teto de 50 vale, failed_steps fica vazio, e a espera dos demais fica no N medido`, async () => { // ADR-002
      const { runs, logs } = await play(ROUNDS, notes);
      const deferred = runs.map((r) => r.deferred_steps as string[]);
      expect(runs.map((r) => [r.status, (r.failed_steps as string[]).length, r.demo_enabled])).toEqual(runs.map(() => ['ok', 0, true]));
      for (const d of deferred) for (const name of FIXED_NAMES) expect(d, `${name} adiado`).not.toContain(name);
      expect(Math.max(...runs.map((r) => Number(r.subrequests))), `gasto por rodada: ${runs.map((r) => r.subrequests).join(', ')}`).toBeLessThanOrEqual(SUBREQUEST_CAP);
      // #371 Nenhum passo gastou mais que o declarado: o custo declarado de cada um vale na rodada de verdade.
      expect(logs.filter((l) => l.includes('corrija o custo declarado') || l.includes('falhou'))).toEqual([]);
      const waits = longestWaits(deferred);
      const bound = Object.entries(waits).filter(([name]) => !(BEYOND_THE_BUDGET[notes] ?? []).includes(name));
      expect(Math.max(...bound.map(([, wait]) => wait)), JSON.stringify(waits)).toBe(ROTATION_WAIT_MAX[notes]);
      for (const name of BEYOND_THE_BUDGET[notes] ?? []) expect(waits[name], `${name} não passa fome da lista`).toBeGreaterThan(ROTATION_WAIT_MAX[notes] ?? 0);
    }, 120_000);
  }

  it('o passo fixo nunca é adiado nem cai na fila de espera: a primeira rodada, com todas as filas cheias, já roda os quatro', async () => { // ADR-002
    const { runs } = await play(1, 8);
    expect((runs[0]?.deferred_steps as string[]).filter((n) => FIXED_NAMES.includes(n))).toEqual([]);
    expect(runs[0]?.failed_steps).toEqual([]);
  });
});

describe('#371/AC-2 a nota demo que chega tem proposta e decisão do motor em até 2 rodadas', () => { // ADR-002
  for (const [notes, delegation] of [[8, false], [8, true], [3, false]] as const) {
    it(`com ${notes} notas por rodada e a fila cheia (delegação ${delegation ? 'ligada' : 'desligada'} na partida), cada nota que chega depois da fila do kit tem proposta e, se o motor a avalia, a decisão, na rodada seguinte à da chegada`, async () => { // ADR-002
      const { w, proposed, decided } = await play(ROUNDS, notes, delegation);
      const WARM = 8; // as rodadas que esvaziam a fila de propostas e de decisões do próprio kit (80 notas, 40 propostas por passo)
      const late = w.arrived.filter((n) => n.round > WARM && n.round + 1 <= ROUNDS);
      expect(late.length).toBeGreaterThan(0);
      const candidates = late.filter((n) => w.fake.rows('divergences').some((d) => d.invoice_access_key === n.key && d.classification === 'E4'));
      expect(candidates.length, 'há nota candidata do motor, senão a prova é vazia').toBeGreaterThan(0);
      expect(late.filter((n) => !proposed[n.round]?.has(n.key)).map((n) => [n.key, n.round])).toEqual([]);
      expect(candidates.filter((n) => !decided[n.round]?.has(n.key)).map((n) => [n.key, n.round])).toEqual([]);
    }, 120_000);
  }
});
