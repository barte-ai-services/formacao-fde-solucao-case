// #311 A gravação de automation_runs quando o banco ainda não tem as colunas failed_steps e subrequests (a migração roda no
// #311 deploy do Supabase, em paralelo ao do Worker): o insert é refeito sem elas e a linha não se perde.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_FIGURES, recordRun } from '../../src/automation/runs.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { tick } from '../../src/cron/tick.js';
import type { Env } from '../../src/env.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { countSubrequests } from '../support/subrequest-counter.js';

const ENV: Env = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
const NO_COLUMN = { code: 'PGRST204', message: "Could not find the 'failed_steps' column of 'automation_runs' in the schema cache" };
const RUN = { startedAt: new Date(), finishedAt: new Date(), status: 'ok' as const, figures: NO_FIGURES, failedSteps: ['dock'], subrequests: 12 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const restOf = (fake: FakePostgrest) => new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
const posts = (fake: FakePostgrest) => fake.requests.filter((r) => r.method === 'POST' && r.url.includes('/automation_runs'));

describe('#311 recordRun sem as colunas novas', () => {
  it('refaz o insert sem failed_steps e subrequests quando o PostgREST diz que a coluna não existe (PGRST204)', async () => {
    const fake = new FakePostgrest();
    fake.failNext('automation_runs', 'POST', 400, NO_COLUMN);

    await recordRun(restOf(fake), RUN);

    expect(posts(fake)).toHaveLength(2);
    const rows = fake.rows('automation_runs');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'ok' });
    expect(rows[0]).not.toHaveProperty('failed_steps');
    expect(rows[0]).not.toHaveProperty('subrequests');
  });

  it('outra falha do insert não é refeita: sobe como estava', async () => {
    const fake = new FakePostgrest();
    fake.failNext('automation_runs', 'POST', 500, { code: 'XX000', message: 'boom' });

    await expect(recordRun(restOf(fake), RUN)).rejects.toMatchObject({ status: 500 });

    expect(posts(fake)).toHaveLength(1);
  });

  it('o tick com o banco sem as colunas e o teto de 50 grava a linha pelo reenvio, dentro dos 50', async () => {
    const fake = new FakePostgrest(kitTables());
    vi.stubGlobal('fetch', fake.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await tick({ cron: '*/15 * * * *' }, ENV);
    const before = fake.rows('automation_runs').length;
    fake.failNext('automation_runs', 'POST', 400, NO_COLUMN);
    const counter = countSubrequests(fake.fetch, 50);
    vi.stubGlobal('fetch', counter.fetch);

    await expect(tick({ cron: '*/15 * * * *' }, ENV)).resolves.not.toBeNull();

    expect(fake.rows('automation_runs')).toHaveLength(before + 1);
    expect(counter.count()).toBeLessThanOrEqual(50);
    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith('cron: rodada não registrada'))).toBe(false);
  });
});
