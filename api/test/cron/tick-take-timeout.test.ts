// #356 AC-3 O RPC da trava passa do timeout do cliente: o Postgres conclui e grava a trava, o cliente aborta e `take` lança. Sem soltar,
// #356 AC-3 a trava fica presa 5 min (LOCK_TTL_MS) e sem linha em automation_runs. A rodada manual e a reconferência soltam com o dono que geraram.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runManualRound, tickAfterLock } from '../../src/cron/tick.js';
import type { Env } from '../../src/env.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

const ENV: Env = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** #356 AC-3 O banco atende o take (a trava fica gravada) e o cliente aborta: a resposta nunca chega. */
function takeTimesOut(): FakePostgrest {
  const fake = new FakePostgrest(kitTables());
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const response = await fake.fetch(input, init);
    if (input.includes('rpc/take_automation_lock')) throw new DOMException('timeout', 'TimeoutError');
    return response;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return fake;
}

describe('#356/AC-3 o take que passa do timeout não deixa a trava presa', () => {
  it('#356/AC-3 a rodada manual: o take lança, a trava gravada é solta com o mesmo dono e o erro sobe', async () => {
    const fake = takeTimesOut();
    await expect(runManualRound(ENV)).rejects.toThrow();
    const release = fake.requests.find((r) => r.url.includes('rpc/release_automation_lock'));
    expect(release).toBeDefined();
    expect(fake.rows('automation_lock')).toEqual([]);
    expect(fake.rows('automation_runs')).toEqual([]);
  });

  it('#356/AC-3 a reconferência: o take lança, a trava gravada é solta, o domínio não é apagado e o erro sobe', async () => {
    const fake = takeTimesOut();
    const before = vi.fn(async () => {});
    await expect(tickAfterLock({ cron: 'reconferir' }, ENV, before)).rejects.toThrow();
    expect(before).not.toHaveBeenCalled();
    expect(fake.requests.some((r) => r.url.includes('rpc/release_automation_lock'))).toBe(true);
    expect(fake.rows('automation_lock')).toEqual([]);
  });
});
