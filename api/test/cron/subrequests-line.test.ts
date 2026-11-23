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

const CRON = { cron: '* * * * *', scheduledTime: Date.parse('2026-11-23T10:15:00Z') };

const lineOf = (log: { mock: { calls: unknown[][] } }, prefix: string): string[] =>
  log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(prefix));

describe('#311 a conta de subrequests no fim de cada invocação', () => {
  it('o tick loga `subrequests n/50` com o n das chamadas ao fetch e grava o mesmo n em automation_runs', async () => {
    const fake = new FakePostgrest(kitTables());
    const counter = countSubrequests(fake.fetch, 1000);
    vi.stubGlobal('fetch', counter.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await tick(CRON, SUPABASE_ENV);

    const n = counter.count();
    expect(lineOf(log, 'cron: subrequests')).toEqual([`cron: subrequests ${n}/50 (tick ${CRON.cron})`]);
    // #356 A gravação conta a si mesma; a soltura da trava, que vem depois dela, só entra na linha do log.
    expect(fake.rows('automation_runs')[0]?.subrequests).toBe(n - 1);
  });

  it('o tick que falha na captura também loga a linha e grava o n', async () => {
    const fake = new FakePostgrest(kitTables());
    const counter = countSubrequests((input, init) => (input.includes('/invoices') ? Promise.reject(new TypeError('x')) : fake.fetch(input, init)), 1000);
    vi.stubGlobal('fetch', counter.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(tick(CRON, SUPABASE_ENV)).rejects.toThrow();

    const n = counter.count();
    expect(lineOf(log, 'cron: subrequests')).toEqual([`cron: subrequests ${n}/50 (tick ${CRON.cron})`]);
    // #356 A gravação conta a si mesma; a soltura da trava, que vem depois dela, só entra na linha do log.
    expect(fake.rows('automation_runs')[0]?.subrequests).toBe(n - 1);
  });

  it('o cron do dossiê loga `subrequests n/50`, contando também a Messages API', async () => {
    const fake = await kitAwaitingPeople();
    const log = vi.spyOn(console, 'log');
    log.mockClear();

    const run = await runDossierCron(fake, WITH_CLAUDE);

    expect(run.claudeCalls()).toBeGreaterThan(0);
    expect(lineOf(log, 'cron: subrequests')).toEqual([`cron: subrequests ${run.counter.count()}/50 (dossiê 11-59/15 * * * *)`]);
  });

  it('#356 a conta do tick sobre a base do kit: a rodada quieta (sem nota nova, sem Claude) faz 25 chamadas, dentro dos 50 do plano gratuito', async () => {
    const fake = new FakePostgrest(kitTables());
    vi.stubGlobal('fetch', fake.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await tick(CRON, SUPABASE_ENV);
    const counter = countSubrequests(fake.fetch, 1000);
    vi.stubGlobal('fetch', counter.fetch);

    await tick(CRON, SUPABASE_ENV);

    // #311 Antes do orçamento (#356) a mesma rodada fazia 67 chamadas; agora os passos que não cabem ficam para a rodada seguinte. #362 A captura quieta e a leitura única de cada consulta a levam a 25.
    expect(counter.count()).toBe(25);
    expect(counter.count()).toBeLessThanOrEqual(50);
  });
});
