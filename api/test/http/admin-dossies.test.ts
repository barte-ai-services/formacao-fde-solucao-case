// #311 GET /api/admin/dossies: o que o administrador precisa para ver o dossiê automático sem acesso ao banco: as contagens
// #311 por gatilho e status e os pedidos pendentes ou com erro. Sem e-mail de quem pediu, sem a saída do Claude.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorker } from '../../src/index.js';
import type { Env } from '../../src/env.js';
import { isRecord } from '../../src/connectors/guards.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { accessEnv, accessKit, type AccessKit } from '../support/access-token.js';

// #311 dublê: só o contrato usado (o ExecutionContext que o Worker lê).
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const ADMIN = 'cfo@jachegou.test';
const ANALYST_EMAIL = 'analista@jachegou.test';
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
  outsider = await accessKit(ANALYST_EMAIL);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function call(options: { as?: AccessKit | null; env?: Env; method?: string } = {}): Promise<Response> {
  const headers = new Headers();
  const who = options.as === undefined ? kit : options.as;
  if (who) headers.set('Cf-Access-Jwt-Assertion', await who.token());
  const worker = createWorker({ verifier: (who ?? kit).verifier });
  return worker.fetch(new Request('https://worker.test/api/admin/dossies', { method: options.method ?? 'GET', headers }), options.env ?? env, ctx);
}

const suggestion = (trigger: string, status: string) => ({ task: 'dossier', input_key: `k-${trigger}-${status}-${Math.random()}`, trigger, status, output: { summary: 'SEGREDO-DA-SAIDA' }, input: { prompt: 'x' }, error: 'ClaudeError: detalhe', requested_by: ANALYST_EMAIL });
const otherTask = { task: 'description-match', input_key: 'z', trigger: 'event', status: 'ok' };
const request = (over: Record<string, unknown>) => ({ id: 1, input_key: 'k', requested_by: ANALYST_EMAIL, requested_at: '2026-11-22T10:00:00.000Z', finished_at: null, trigger: 'event', status: 'pending', reason: null, ...over });

function serve(): FakePostgrest {
  const fake = new FakePostgrest({
    claude_suggestions: [suggestion('event', 'ok'), suggestion('event', 'ok'), suggestion('event', 'error'), suggestion('on_demand', 'ok'), otherTask],
    dossier_requests: [
      request({ id: 1, input_key: 'a', status: 'pending', requested_by: 'backfill' }),
      request({ id: 2, input_key: 'b', status: 'error', reason: 'rate_limited', finished_at: '2026-11-22T10:01:00.000Z', requested_by: 'claude' }),
      request({ id: 3, input_key: 'c', status: 'done', finished_at: '2026-11-22T10:02:00.000Z' }),
      request({ id: 4, input_key: 'd', status: 'running', requested_by: ANALYST_EMAIL, trigger: 'on_demand' }),
    ],
  });
  vi.stubGlobal('fetch', fake.fetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return fake;
}

describe('#311 GET /api/admin/dossies', () => {
  it('#311/AC-2 o administrador vê as contagens do dossiê por gatilho e status', async () => {
    serve();
    const response = await call();
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(isRecord(body) ? body.suggestions : undefined).toEqual([
      { trigger: 'event', status: 'error', count: 1 },
      { trigger: 'event', status: 'ok', count: 2 },
      { trigger: 'on_demand', status: 'ok', count: 1 },
    ]);
  });

  it('#311/AC-3 e AC-4 lista só os pedidos pending e error, com o motivo, e nunca quem pediu nem a saída do Claude', async () => {
    const fake = serve();
    const response = await call();
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    const requests = isRecord(body) && Array.isArray(body.requests) ? body.requests.filter(isRecord) : [];
    expect(requests.map((r) => r.input_key).sort()).toEqual(['a', 'b']);
    expect(requests.find((r) => r.input_key === 'b')).toEqual({
      input_key: 'b',
      trigger: 'event',
      status: 'error',
      reason: 'rate_limited',
      requested_at: '2026-11-22T10:00:00.000Z',
      finished_at: '2026-11-22T10:01:00.000Z',
    });
    expect(text).not.toContain(ANALYST_EMAIL);
    expect(text).not.toContain('SEGREDO-DA-SAIDA');
    // #311 As colunas lidas são as nomeadas, não a linha inteira.
    const selects = fake.requests.map((r) => new URL(r.url).searchParams.get('select'));
    expect(selects).toEqual(expect.arrayContaining(['trigger,status']));
    expect(selects.every((s) => s !== null && s !== '*' && !/output|input,|error|requested_by/.test(s))).toBe(true);
  });

  it('sem o papel de administrador: 403 e nenhuma leitura', async () => {
    const fake = serve();
    const response = await call({ as: outsider });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(fake.requests).toHaveLength(0);
  });

  it('sem login: 401, o que o Access do roteador devolve, e nenhuma leitura', async () => {
    const fake = serve();
    expect((await call({ as: null })).status).toBe(401);
    expect(fake.requests).toHaveLength(0);
  });

  it('sem a variável de administradores, ninguém passa (fail-closed)', async () => {
    serve();
    const { BARTE_ACADEMY_ADMIN_EMAILS: _omit, ...withoutAdmins } = env;
    expect((await call({ env: withoutAdmins })).status).toBe(403);
  });

  it('método errado: 405 com Allow GET', async () => {
    serve();
    const response = await call({ method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });

  it('sem as credenciais do Supabase: 503', async () => {
    serve();
    const { BARTE_ACADEMY_SUPABASE_URL: _u, BARTE_ACADEMY_SUPABASE_SECRET_KEY: _k, ...withoutSupabase } = env;
    expect((await call({ env: withoutSupabase })).status).toBe(503);
  });

  it('erro do Supabase: 502 genérico, sem o texto do erro na resposta e só operação, tabela e status no log', async () => {
    const fake = serve();
    fake.failNext('claude_suggestions', 'GET', 500, { message: 'DETALHE-INTERNO-DO-BANCO' });
    const response = await call();
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain('DETALHE-INTERNO-DO-BANCO');
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain('DETALHE-INTERNO-DO-BANCO');
    expect(logged).toContain('claude_suggestions');
  });
});
