// #356 AC-2 POST /api/admin/rodar-agora e POST /api/admin/modo-demonstracao: só o administrador, só JSON, sem detalhe do banco na resposta.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorker } from '../../src/index.js';
import type { Env } from '../../src/env.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { accessEnv, accessKit, type AccessKit } from '../support/access-token.js';
import { kitTables } from '../support/kit.js';

const ADMIN = 'cfo@jachegou.test';
const env: Env = {
  ...accessEnv,
  BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co',
  BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_teste',
  BARTE_ACADEMY_ADMIN_EMAILS: JSON.stringify([ADMIN]),
};
const RUN = '/api/admin/rodar-agora';
const MODE = '/api/admin/modo-demonstracao';
const SEED_MODE = { id: true, enabled: false, changed_by: null, changed_at: '2026-11-23T09:00:00+00:00', version: 1, history: [] };

let admin: AccessKit;
let outsider: AccessKit;
beforeAll(async () => {
  admin = await accessKit(ADMIN);
  outsider = await accessKit('analista@jachegou.test');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Deferred = Promise<unknown>[];
async function call(path: string, options: { as?: AccessKit | null; env?: Env; method?: string; body?: unknown; type?: string; deferred?: Deferred; at?: string } = {}): Promise<Response> {
  const who = options.as === undefined ? admin : options.as;
  const headers = new Headers({ 'Content-Type': options.type ?? 'application/json' });
  if (who) headers.set('Cf-Access-Jwt-Assertion', await who.token());
  // O verificador do Access lê o relógio real: o token sai antes de o teste fixar a data.
  if (options.at) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(options.at));
  }
  const ctx = { waitUntil: (p: Promise<unknown>) => void options.deferred?.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const request = new Request(`https://worker.test${path}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
  return createWorker({ verifier: (who ?? admin).verifier }).fetch(request, options.env ?? env, ctx);
}

function serve(extra: Record<string, Record<string, unknown>[]> = {}): FakePostgrest {
  const fake = new FakePostgrest({ ...kitTables(), demo_settings: [{ ...SEED_MODE }], ...extra });
  vi.stubGlobal('fetch', fake.fetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return fake;
}

describe.each([RUN, MODE])('#356/AC-2 %s: as barreiras de sempre das rotas de administração', (path) => { // ADR-002
  const body = path === MODE ? { enabled: true } : {};

  it('#356/AC-2 quem não é administrador: 403, e nada é lido nem gravado', async () => {
    const fake = serve();
    expect((await call(path, { as: outsider, body })).status).toBe(403);
    expect(fake.requests).toHaveLength(0);
  });

  it('#356/AC-2 sem a variável de administradores ninguém passa (fail-closed)', async () => {
    const fake = serve();
    const { BARTE_ACADEMY_ADMIN_EMAILS: _omit, ...semAdmin } = env;
    expect((await call(path, { env: semAdmin, body })).status).toBe(403);
    expect(fake.requests).toHaveLength(0);
  });

  it('#356/AC-2 sem login: 401', async () => {
    serve();
    expect((await call(path, { as: null, body })).status).toBe(401);
  });

  it('#356/AC-2 só POST: GET do administrador é 405 com Allow, e o de quem não é, 403', async () => {
    serve();
    const get = await call(path, { method: 'GET' });
    expect(get.status).toBe(405);
    expect(get.headers.get('Allow')).toBe('POST');
    expect((await call(path, { as: outsider, method: 'GET' })).status).toBe(403);
  });

  it('#356/AC-2 corpo que não é application/json: 415, e nada é lido nem gravado', async () => {
    const fake = serve();
    expect((await call(path, { type: 'text/plain', body: JSON.stringify(body) })).status).toBe(415);
    expect(fake.requests).toHaveLength(0);
  });

  it('#356/AC-2 sem as credenciais do Supabase: 503', async () => {
    serve();
    const { BARTE_ACADEMY_SUPABASE_SECRET_KEY: _omit, ...semChave } = env;
    expect((await call(path, { env: semChave, body })).status).toBe(503);
  });
});

describe('#356/AC-2 POST /api/admin/rodar-agora', () => { // ADR-002
  it('#356/AC-2 o administrador recebe 202 na hora e a rodada de origem manual começa no waitUntil', async () => {
    const fake = serve();
    const deferred: Deferred = [];
    const started = Date.now();
    const response = await call(RUN, { body: {}, deferred });
    expect(response.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await response.json()).toEqual({ accepted: true, origin: 'manual' });
    // A resposta saiu antes da rodada: nada gravado ainda, e a rodada está pendurada no waitUntil.
    expect(fake.rows('automation_runs')).toEqual([]);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(fake.rows('automation_runs')).toHaveLength(1);
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'ok', origin: 'manual' });
  });

  it('#356/AC-2 o corpo é opcional: sem corpo nenhum também dispara', async () => {
    serve();
    const deferred: Deferred = [];
    expect((await call(RUN, { deferred })).status).toBe(202);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
  });

  it('#356/AC-3 com a trava tomada, responde 202 do mesmo jeito e a rodada pula, gravada como skipped manual', async () => {
    const fake = serve({ automation_lock: [{ id: true, owner: 'outra', expires_at: '2026-11-23T10:20:00.000Z' }] });
    const deferred: Deferred = [];
    expect((await call(RUN, { body: {}, deferred, at: '2026-11-23T10:15:30Z' })).status).toBe(202);
    await Promise.all(deferred);
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'skipped', origin: 'manual' });
  });

  it('#356/AC-2 a falha da rodada no waitUntil não derruba nada e não vaza o texto do banco no log', async () => {
    serve();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => new Response('{"message":"segredo-do-banco"}', { status: 500 }));
    const deferred: Deferred = [];
    expect((await call(RUN, { body: {}, deferred })).status).toBe(202);
    await expect(Promise.all(deferred)).resolves.toBeDefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain('segredo-do-banco');
    expect(JSON.stringify(log.mock.calls)).not.toContain(ADMIN);
  });
});

describe('#356/AC-2 POST /api/admin/modo-demonstracao', () => { // ADR-002
  it('#356/AC-2 liga o modo sem deploy: grava enabled, quem mudou (o e-mail do Access) e quando; a resposta não leva o e-mail', async () => {
    const fake = serve();
    const response = await call(MODE, { body: { enabled: true }, at: '2026-11-23T10:00:00Z' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true, changedAt: '2026-11-23T10:00:00.000Z' });
    expect(fake.rows('demo_settings')[0]).toMatchObject({ enabled: true, changed_by: ADMIN, changed_at: '2026-11-23T10:00:00.000Z', version: 2 });
  });

  it('#356/AC-2 desliga o modo do mesmo jeito', async () => {
    const fake = serve();
    fake.tables.set('demo_settings', [{ ...SEED_MODE, enabled: true }]);
    expect((await call(MODE, { body: { enabled: false } })).status).toBe(200);
    expect(fake.rows('demo_settings')[0]).toMatchObject({ enabled: false, changed_by: ADMIN });
  });

  it.each([
    ['sem corpo', undefined],
    ['corpo vazio', {}],
    ['enabled como texto', { enabled: 'true' }],
    ['enabled nulo', { enabled: null }],
    ['campo a mais', { enabled: true, outro: 1 }],
    ['lista', [true]],
    ['JSON malformado', '{"enabled":'],
  ])('#356/AC-2 corpo inválido (%s): 400, e nada é gravado', async (_name, body) => {
    const fake = serve();
    const response = await call(MODE, { body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_body' });
    expect(fake.requests).toHaveLength(0);
  });

  it('#356/AC-2 a troca que perdeu a corrida (a versão andou) é 409, sem o e-mail nem o history', async () => {
    const fake = serve();
    fake.failNext('demo_settings', 'PATCH', 200, []);
    const response = await call(MODE, { body: { enabled: true } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'conflict' });
  });

  it('#356/AC-2 sem a linha do modo (migração não aplicada) vira o erro genérico 502, nunca o texto do banco', async () => {
    const fake = serve();
    fake.tables.set('demo_settings', []);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await call(MODE, { body: { enabled: true } });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'modo_demonstracao_failed' });
    expect(JSON.stringify(error.mock.calls)).not.toContain(ADMIN);
  });

  it('#356/AC-2 falha do banco: 502 genérico, e o log leva só a operação, a tabela e o status', async () => {
    serve();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => new Response('{"message":"segredo-do-banco","hint":"x"}', { status: 500 }));
    const response = await call(MODE, { body: { enabled: true } });
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain('segredo-do-banco');
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('demo_settings');
    expect(logged).not.toContain('segredo-do-banco');
    expect(logged).not.toContain(ADMIN);
  });
});
