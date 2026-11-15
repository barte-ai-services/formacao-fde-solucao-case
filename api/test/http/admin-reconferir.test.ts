// #174 POST /api/admin/reconferir: a reconferência como operação do Worker, só para o administrador.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorker } from '../../src/index.js';
import type { Env } from '../../src/env.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { accessEnv, accessKit, type AccessKit } from '../support/access-token.js';
import { kitTables } from '../support/kit.js';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const ADMIN = 'cfo@jachegou.test';
const env: Env = {
  ...accessEnv,
  BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co',
  BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_teste',
  BARTE_ACADEMY_ADMIN_EMAILS: JSON.stringify([ADMIN]),
};

let kit: AccessKit;
let outsider: AccessKit;
beforeAll(async () => {
  kit = await accessKit(ADMIN);
  outsider = await accessKit('analista@jachegou.test');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function call(options: { as?: AccessKit | null; env?: Env; method?: string; body?: unknown } = {}): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const who = options.as === undefined ? kit : options.as;
  if (who) headers.set('Cf-Access-Jwt-Assertion', await who.token());
  const worker = createWorker({ verifier: (who ?? kit).verifier });
  const request = new Request('https://worker.test/api/admin/reconferir', {
    method: options.method ?? 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return worker.fetch(request, options.env ?? env, ctx);
}

function serve(): FakePostgrest {
  const fake = new FakePostgrest(kitTables());
  vi.stubGlobal('fetch', fake.fetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return fake;
}

const confirm = { confirmar: 'RECONFERIR' };

describe('#174 POST /api/admin/reconferir', () => {
  it('sem login: 401, e nada é apagado', async () => {
    const fake = serve();
    const response = await call({ as: null, body: confirm });
    expect(response.status).toBe(401);
    expect(fake.requests).toHaveLength(0);
  });

  it('sem o papel de administrador: 403, e nada é apagado', async () => {
    const fake = serve();
    const response = await call({ as: outsider, body: confirm });
    expect(response.status).toBe(403);
    expect(fake.requests).toHaveLength(0);
  });

  it('sem a variável de administradores, ninguém passa (fail-closed)', async () => {
    serve();
    const { BARTE_ACADEMY_ADMIN_EMAILS: _omit, ...semAdmin } = env;
    expect((await call({ env: semAdmin, body: confirm })).status).toBe(403);
  });

  it.each([
    ['sem corpo', undefined],
    ['confirmação errada', { confirmar: 'reconferir' }],
    ['corpo vazio', {}],
  ])('administrador %s: 400, e nada é apagado', async (_name, body) => {
    const fake = serve();
    const response = await call({ body });
    expect(response.status).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });

  it('só aceita POST: GET responde 405', async () => {
    serve();
    expect((await call({ method: 'GET' })).status).toBe(405);
  });

  it('sem as credenciais do Supabase: 503', async () => {
    serve();
    const { BARTE_ACADEMY_SUPABASE_SECRET_KEY: _omit, ...semChave } = env;
    expect((await call({ env: semChave, body: confirm })).status).toBe(503);
  });

  it('caminho feliz: apaga o domínio, reconfere as 80 notas e devolve o resumo', async () => {
    const fake = serve();
    const kitBefore = Object.fromEntries(Object.keys(kitTables()).map((t) => [t, fake.rows(t).length]));
    const first = await call({ body: confirm });
    expect(first.status).toBe(200);

    fake.tables.set('outbox_dock_actions', [{ id: 99, invoice_access_key: 'k', payload: {} }]);
    const response = await call({ body: confirm });
    expect(response.status).toBe(200);
    const summary = (await response.json()) as Record<string, number>;
    expect(summary).toMatchObject({ vistas: 80, novas: 80, conferidas: 80, comErro: 0 });
    expect(summary.propostas).toBeGreaterThan(0);
    expect(fake.rows('invoices')).toHaveLength(80);
    expect(fake.rows('outbox_dock_actions').some((r) => r.id === 99)).toBe(false);
    expect(Object.fromEntries(Object.keys(kitTables()).map((t) => [t, fake.rows(t).length]))).toEqual(kitBefore);
    const deletes = fake.requests.filter((r) => r.method === 'DELETE');
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every((r) => !new URL(r.url).pathname.includes('/kit_'))).toBe(true);
  });
});
