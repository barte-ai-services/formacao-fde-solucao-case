// #356 AC-5 O ao vivo (#354) convive com as rodadas puladas: a linha `skipped` não vira passo, não quebra a leitura e não vira a "última rodada".
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRecord } from '../../src/connectors/guards.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

const env: Env = {
  BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake',
  ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com',
};
// #356 O roteador só chama `waitUntil` neste teste; o resto do ExecutionContext não é lido, então o cast parcial basta.
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const verifier: AccessVerifier = { verify: async (token) => ({ ok: true, identity: { email: token } }) };

afterEach(() => vi.unstubAllGlobals());

const call = (fake: FakePostgrest, path = '/api/live') => {
  vi.stubGlobal('fetch', fake.fetch);
  const headers = new Headers({ 'Cf-Access-Jwt-Assertion': 'ana@jachegou.test' });
  return createWorker({ verifier }).fetch(new Request(`https://worker.test${path}`, { headers }), env, ctx);
};

const FIGURES = {
  seen: 0, inserted: 0, checked: 0, failed: 0, proposed: 0, approved_by_rule: 0, cadastro_e8: 0, dock_published: 0,
  store_published: 0, duplicates_blocked: 0, engine_evaluated: 0, engine_approved: 0,
};
const ranRun = (id: number, at: string) => ({ id, started_at: at, finished_at: at, status: 'ok', ...FIGURES, seen: 3, error: null });
// A linha que a migração da #356 permite: status skipped e as colunas novas.
const skippedRun = (id: number, at: string) => ({
  id, started_at: at, finished_at: at, status: 'skipped', ...FIGURES, error: null, origin: 'cron', demo_enabled: true, deferred_steps: [],
});

type Body = { events: { kind: unknown; at: unknown; status: unknown }[]; since: unknown; indicators: unknown };

// #356 A resposta chega como `unknown` e é estreitada antes do uso (runtime-validation, condição 2).
async function bodyOf(res: Response): Promise<Body> {
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.events)) throw new Error('a resposta de /api/live não tem a forma esperada');
  const events = body.events.map((event: unknown) => {
    if (!isRecord(event)) throw new Error('um evento de /api/live não é um objeto');
    return { kind: event.kind, at: event.at, status: event.status };
  });
  return { events, since: body.since ?? null, indicators: body.indicators };
}

describe('#356/AC-5 GET /api/live com rodadas puladas', () => {
  const rows = [ranRun(1, '2026-11-23T10:00:00.000Z'), skippedRun(2, '2026-11-23T10:01:00.000Z'), skippedRun(3, '2026-11-23T10:02:00.000Z')];

  it('#356/AC-5 Dado uma rodada que rodou e duas puladas mais novas, o ao vivo responde 200 e só a que rodou vira passo', async () => {
    const res = await call(new FakePostgrest({ automation_runs: rows }));
    const body = await bodyOf(res);
    expect(res.status).toBe(200);
    expect(body.events.map((e) => [e.kind, e.at, e.status])).toEqual([['run', '2026-11-23T10:00:00.000Z', 'ok']]);
    expect(body.since).toBe('2026-11-23T10:00:00.000Z');
  });

  it('#356/AC-5 com o cursor `since`, a pulada também não entra e o filtro do cursor não solta o filtro de status', async () => {
    const more = [...rows, ranRun(4, '2026-11-23T10:03:00.000Z')];
    const res = await call(new FakePostgrest({ automation_runs: more }), '/api/live?since=2026-11-23T10:00:00.000Z');
    const body = await bodyOf(res);
    expect(res.status).toBe(200);
    expect(body.events.map((e) => [e.kind, e.at])).toEqual([['run', '2026-11-23T10:03:00.000Z']]);
  });

  it('#356/AC-5 só rodadas puladas: nenhum passo e nenhum falso alarme (200, eventos vazios)', async () => {
    const res = await call(new FakePostgrest({ automation_runs: [skippedRun(1, '2026-11-23T10:01:00.000Z')] }));
    const body = await bodyOf(res);
    expect(res.status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.since).toBeNull();
  });

  it('#356/AC-5 os indicadores do ao vivo são os mesmos com e sem as puladas (não leem automation_runs)', async () => {
    const day = async (runs: Record<string, unknown>[]) => (await bodyOf(await call(new FakePostgrest({ automation_runs: runs })))).indicators;
    expect(await day(rows)).toEqual(await day(rows.slice(0, 1)));
  });

  it('#356/AC-5 antes da migração (linhas sem as colunas novas e sem a tabela do modo) o ao vivo segue funcionando', async () => {
    const res = await call(new FakePostgrest({ automation_runs: [ranRun(1, '2026-11-23T10:00:00.000Z')] }));
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).events).toHaveLength(1);
  });
});
