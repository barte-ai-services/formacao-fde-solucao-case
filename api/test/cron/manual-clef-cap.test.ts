// #356 AC-2 O Clef da rodada manual não depende do banco: `engine_settings.clef_timeout_ms` só exige > 0, e um valor alto estoura a janela do
// #356 AC-2 waitUntil (a conta de cron/manual-window.ts supõe o Clef no teto). A rodada manual usa o menor entre o do banco e o teto; o Cron e a reconferência, o do banco.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLEF_TIMEOUT_MS } from '../../src/cron/manual-window.js';
import { runManualRound, tick } from '../../src/cron/tick.js';
import type { Env } from '../../src/env.js';
import { SupabaseEngineStore } from '../../src/engine/supabase-store.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { fakeAi } from '../support/fake-ai.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ABOVE_CAP = CLEF_TIMEOUT_MS * 10;
const ENV: Env = {
  BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co',
  BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake',
  ai: fakeAi(async () => ({ response: { outcome: 'approve', confidence: 0.99, reason: 'fecha' } })),
};

/** #356 AC-2 O que o motor leu como prazo do Clef em cada leitura de `engine_settings` da rodada. */
function watchClefTimeout(timeoutInDb: number): { seen: number[] } {
  const fake = new FakePostgrest({
    ...kitTables(),
    // #356 AC-2 A rodada anterior adiou o motor: ele passa à frente e roda nesta (planRound), então o Clef é lido.
    automation_runs: [{ status: 'ok', origin: 'cron', started_at: '2026-11-23T10:00:00Z', finished_at: '2026-11-23T10:00:05Z', deferred_steps: ['motor'] }],
    engine_settings: [{ level: 'analista', delegation_enabled: true, confidence_threshold: 0.98, clef_timeout_ms: timeoutInDb }],
  });
  vi.stubGlobal('fetch', fake.fetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const seen: number[] = [];
  const original = SupabaseEngineStore.prototype.settings;
  vi.spyOn(SupabaseEngineStore.prototype, 'settings').mockImplementation(async function (this: SupabaseEngineStore, level: string) {
    const settings = await original.call(this, level);
    seen.push(settings.clefTimeoutMs);
    return settings;
  });
  return { seen };
}

describe('#356/AC-2 o prazo do Clef na rodada manual', () => {
  it('#356/AC-2 com o valor do banco acima do teto, o Clef da rodada manual usa o teto', async () => {
    const watch = watchClefTimeout(ABOVE_CAP);
    await runManualRound(ENV);
    expect(watch.seen.length).toBeGreaterThan(0);
    expect(watch.seen.every((ms) => ms === CLEF_TIMEOUT_MS)).toBe(true);
  });

  it('#356/AC-2 com o valor do banco abaixo do teto, vale o do banco', async () => {
    const watch = watchClefTimeout(3_000);
    await runManualRound(ENV);
    expect(watch.seen.length).toBeGreaterThan(0);
    expect(watch.seen.every((ms) => ms === 3_000)).toBe(true);
  });

  it('#356/AC-2 o Cron não muda: vale o valor do banco, acima do teto', async () => {
    const watch = watchClefTimeout(ABOVE_CAP);
    await tick({ cron: '* * * * *', scheduledTime: Date.parse('2026-11-23T10:15:00Z') }, ENV);
    expect(watch.seen.length).toBeGreaterThan(0);
    expect(watch.seen.every((ms) => ms === ABOVE_CAP)).toBe(true);
  });

  it('#356/AC-2 o repositório limita o valor lido ao teto que recebe, e sem teto devolve o do banco', async () => {
    const fake = new FakePostgrest({ engine_settings: [{ level: 'analista', delegation_enabled: false, confidence_threshold: 0.9, clef_timeout_ms: ABOVE_CAP }] });
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    expect((await new SupabaseEngineStore(rest, CLEF_TIMEOUT_MS).settings('analista')).clefTimeoutMs).toBe(CLEF_TIMEOUT_MS);
    expect((await new SupabaseEngineStore(rest).settings('analista')).clefTimeoutMs).toBe(ABOVE_CAP);
    expect((await new SupabaseEngineStore(new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: new FakePostgrest({}).fetch }), 1_000).settings('outro')).clefTimeoutMs).toBe(1_000);
  });
});
