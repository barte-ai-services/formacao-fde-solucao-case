// #311 Cenário B: a invocação do tick e a do dossiê terminam com uma linha `subrequests <n>/50`, com o n de chamadas ao fetch.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from '../../src/cron/tick.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { countSubrequests } from '../support/subrequest-counter.js';
import { kitAwaitingPeople, runDossierCron, WITH_CLAUDE, SUPABASE_ENV } from '../support/dossier-world.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const lineOf = (log: { mock: { calls: unknown[][] } }, prefix: string): string[] =>
  log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(prefix));

describe('#311 a conta de subrequests no fim de cada invocação', () => {
  it('o tick loga `subrequests n/50` com o n das chamadas ao fetch e grava o mesmo n em automation_runs', async () => {
    const fake = new FakePostgrest(kitTables());
    const counter = countSubrequests(fake.fetch, 1000);
    vi.stubGlobal('fetch', counter.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await tick({ cron: '*/15 * * * *' }, SUPABASE_ENV);

    const n = counter.count();
    expect(lineOf(log, 'cron: subrequests')).toEqual([`cron: subrequests ${n}/50 (tick */15 * * * *)`]);
    expect(fake.rows('automation_runs')[0]?.subrequests).toBe(n);
  });

  it('o tick que falha na captura também loga a linha e grava o n', async () => {
    const fake = new FakePostgrest(kitTables());
    const counter = countSubrequests((input, init) => (input.includes('/invoices') ? Promise.reject(new TypeError('x')) : fake.fetch(input, init)), 1000);
    vi.stubGlobal('fetch', counter.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(tick({ cron: '*/15 * * * *' }, SUPABASE_ENV)).rejects.toThrow();

    const n = counter.count();
    expect(lineOf(log, 'cron: subrequests')).toEqual([`cron: subrequests ${n}/50 (tick */15 * * * *)`]);
    expect(fake.rows('automation_runs')[0]?.subrequests).toBe(n);
  });

  it('o cron do dossiê loga `subrequests n/50`, contando também a Messages API', async () => {
    const fake = await kitAwaitingPeople();
    const log = vi.spyOn(console, 'log');
    log.mockClear();

    const run = await runDossierCron(fake, WITH_CLAUDE);

    expect(run.claudeCalls()).toBeGreaterThan(0);
    expect(lineOf(log, 'cron: subrequests')).toEqual([`cron: subrequests ${run.counter.count()}/50 (dossiê 11-59/15 * * * *)`]);
  });

  it('a conta do tick sobre a base do kit: a rodada quieta (sem nota nova, sem Claude) faz 67 chamadas, acima dos 50 do plano gratuito', async () => {
    const fake = new FakePostgrest(kitTables());
    vi.stubGlobal('fetch', fake.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await tick({ cron: '*/15 * * * *' }, SUPABASE_ENV);
    const counter = countSubrequests(fake.fetch, 1000);
    vi.stubGlobal('fetch', counter.fetch);

    await tick({ cron: '*/15 * * * *' }, SUPABASE_ENV);

    expect(counter.count()).toBe(67);
    expect(counter.count()).toBeGreaterThan(50);
  });
});
