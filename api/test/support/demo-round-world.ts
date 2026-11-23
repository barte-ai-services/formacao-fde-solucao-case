// #371 O mundo de teste da rodada de 1 minuto com o modo demonstração ligado: a rodada mais cheia do kit (os pedidos, as devoluções, a resposta
// #371 a ler, a Messages API e o Workers AI falsos) mais as notas novas que o passo notas-demo grava a cada rodada, de verdade, pelo gerador.
import { vi } from 'vitest';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { startRoundMeter } from '../../src/cron/round-meter.js';
import { buildRoundSteps } from '../../src/cron/round-steps.js';
import { supabaseRoundWork } from '../../src/cron/round-work.js';
import { tick } from '../../src/cron/tick.js';
import { generateDemoBatch } from '../../src/demo/generator.js';
import type { Env } from '../../src/env.js';
import { ENV as CLAUDE_ENV, fullWorld, messagesApi, messagesBody } from './budget-world.js';
import { fakeAi } from './fake-ai.js';
import type { FakePostgrest } from './fake-postgrest.js';
import { AFTER_DUE } from './reply-scenarios.js';

const URL_ = 'https://fake.supabase.co';
const ANTHROPIC = 'https://api.anthropic.com/';
const ANSWER = { summary: 'ok', divergences: [], supplier_history: 'ok' };
const JSON_HEADERS = { 'content-type': 'application/json' };

/** #371 Uma nota que o passo notas-demo gravou: a chave, a rodada em que chegou e o que o gerador espera dela. */
export type ArrivedNote = { readonly key: string; readonly round: number; readonly level: string; readonly classification: string };

export type DemoRoundWorld = {
  readonly fake: FakePostgrest;
  readonly env: Env;
  /** As notas que chegaram, na ordem. */
  readonly arrived: readonly ArrivedNote[];
  /** Roda uma rodada do cron de 1 minuto (o tick) um minuto depois da anterior e devolve a linha gravada dela. */
  readonly round: () => Promise<Record<string, unknown>>;
  readonly roundNumber: () => number;
  /** Roda os passos de uma rodada à mão (os fixos primeiro, os demais na ordem da lista), sem teto, e devolve o que cada um gastou depois dos de antes. */
  readonly measureRound: () => Promise<Map<string, number>>;
};

/**
 * #371 `notesPerRound` é o tamanho do lote de cada rodada (o pior caso é 8; o gerador real sorteia de 3 a 8). Com `delegation` o motor
 * parte da delegação ligada; o modo demonstração a liga de qualquer jeito (#351).
 */
export async function demoRoundWorld({ notesPerRound, delegation = false }: { readonly notesPerRound: number; readonly delegation?: boolean }): Promise<DemoRoundWorld> {
  const { world: w } = await fullWorld();
  w.fake.tables.set('engine_settings', [{ level: 'analista', delegation_enabled: delegation, confidence_threshold: 0.98, clef_timeout_ms: 8000 }]);
  w.fake.tables.set('demo_settings', [{ id: true, enabled: true, changed_by: null, changed_at: '2026-11-23T09:00:00+00:00', version: 1, history: [] }]);
  const api = messagesApi((key) => w.fake.rows('proposals').find((row) => row.invoice_access_key === key));
  const arrived: ArrivedNote[] = [];
  let sequence = 1;
  let round = 0;
  let nowMs = AFTER_DUE.getTime();
  const emptyQueue = () => Promise.resolve(new Response('[]', { status: 200, headers: JSON_HEADERS }));
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/rpc/kit_insert_demo_batch')) {
      const batch = generateDemoBatch({ seed: sequence, count: notesPerRound, now: new Date(nowMs), sequenceStart: sequence });
      sequence += notesPerRound;
      for (const [table, rows] of Object.entries(batch.rows)) w.fake.tables.set(table, [...w.fake.rows(table), ...(rows as Record<string, unknown>[])]);
      for (const [key, expected] of batch.expected) arrived.push({ key, round, level: expected.level, classification: expected.classification });
      return Promise.resolve(new Response(String(notesPerRound), { status: 200, headers: JSON_HEADERS }));
    }
    if (url.includes('/rpc/demo_dock_count_pending') || url.includes('/rpc/demo_supplier_replies_pending')) return emptyQueue();
    if (!url.startsWith(ANTHROPIC)) return w.fake.fetch(url, init);
    const body = messagesBody(init);
    if (Object.keys(body.tools[0]?.input_schema.properties ?? {}).includes('summary')) {
      return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'responder', input: ANSWER }] }), { status: 200 }));
    }
    return api.fetch(url, init);
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AFTER_DUE);
  const env: Env = {
    BARTE_ACADEMY_SUPABASE_URL: URL_,
    BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake',
    BARTE_ACADEMY_ANTHROPIC_API_KEY: CLAUDE_ENV.BARTE_ACADEMY_ANTHROPIC_API_KEY,
    ai: fakeAi(async () => ({ response: { outcome: 'approve', confidence: 0.99, reason: 'fecha' } })),
  };
  return {
    fake: w.fake,
    env,
    arrived,
    roundNumber: () => round,
    measureRound: async () => {
      round += 1;
      nowMs += 60_000;
      vi.setSystemTime(new Date(nowMs));
      const meter = startRoundMeter(env, { measureOnly: true });
      const rest = new SupabaseRest({ url: URL_, secretKey: 'sb_secret_fake', fetch: meter.fetch, memoizeReads: true });
      const { steps } = buildRoundSteps(supabaseRoundWork(rest, meter.env, meter.fetch, { demoMode: async () => true }), Date.now, undefined, true);
      const spent = new Map<string, number>();
      for (const step of steps) {
        const before = meter.spent();
        await step.run();
        spent.set(step.name, meter.spent() - before);
      }
      return spent;
    },
    round: async () => {
      round += 1;
      nowMs += 60_000;
      vi.setSystemTime(new Date(nowMs));
      await tick({ cron: '* * * * *', scheduledTime: nowMs } as never, env);
      const run = w.fake.rows('automation_runs').at(-1);
      if (!run) throw new Error('a rodada não gravou a linha em automation_runs');
      return run;
    },
  };
}
