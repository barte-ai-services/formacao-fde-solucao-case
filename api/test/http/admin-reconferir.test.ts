// #174 POST /api/admin/reconferir: a reconferência como operação do Worker, só para o administrador.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorker } from '../../src/index.js';
import type { Env } from '../../src/env.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { accessEnv, accessKit, type AccessKit } from '../support/access-token.js';
import { kitTables } from '../support/kit.js';
import { roundsUntil } from '../support/rounds.js';
import { tick } from '../../src/cron/tick.js';
import { countSubrequests } from '../support/subrequest-counter.js';

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

  it('só aceita POST: GET do administrador responde 405, e o de quem não é, 403', async () => {
    serve();
    expect((await call({ method: 'GET' })).status).toBe(405);
    expect((await call({ as: outsider, method: 'GET' })).status).toBe(403);
  });

  it('corpo que não é application/json (formulário cross-site): 415, e nada é apagado', async () => {
    const fake = serve();
    const headers = new Headers({ 'Content-Type': 'text/plain', 'Cf-Access-Jwt-Assertion': await kit.token() });
    const request = new Request('https://worker.test/api/admin/reconferir', {
      method: 'POST',
      headers,
      body: '{"confirmar":"RECONFERIR","x":"="}',
    });
    const response = await createWorker({ verifier: kit.verifier }).fetch(request, env, ctx);
    expect(response.status).toBe(415);
    expect(fake.requests).toHaveLength(0);
  });

  it('falha no meio: 502 sem detalhe, e o registro leva quem rodou', async () => {
    const fake = serve();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => new Response('x', { status: 500 }));
    const response = await call({ body: confirm });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'reconferir_failed' });
    expect(error).toHaveBeenCalledWith('admin-reconferir: falhou', expect.objectContaining({ by: ADMIN }));
    expect(fake.requests).toHaveLength(0);
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
    expect(summary).toMatchObject({ seen: 80, inserted: 80, checked: 80, failed: 0 });
    // #356 A rodada é orçada em 50 subrequests e os passos adiados da anterior passam à frente: a proposta pode ficar para a rodada seguinte.
    await roundsUntil(() => tick({ cron: 'reconferir' }, env), () => fake.rows('proposals').length > 0);
    expect(fake.rows('invoices')).toHaveLength(80);
    expect(fake.rows('outbox_dock_actions').some((r) => r.invoice_access_key === 'k')).toBe(false);
    expect(Object.fromEntries(Object.keys(kitTables()).map((t) => [t, fake.rows(t).length]))).toEqual(kitBefore);
    const deletes = fake.requests.filter((r) => r.method === 'DELETE');
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every((r) => !new URL(r.url).pathname.includes('/kit_'))).toBe(true);
  });
  // #356/AC-3 A reconferência toma a trava antes de apagar o domínio.
  describe('#356/AC-3 a reconferência e a trava da rodada', () => {
    const heldBy = (owner: string, minutes: number) => ({ id: true, owner, expires_at: new Date(Date.now() + minutes * 60_000).toISOString() });
    const seedDomain = (fake: FakePostgrest) => fake.tables.set('invoices', [{ access_key: 'k1', state: 'conferida' }]);

    it('#356/AC-3 com a trava tomada e válida: 409 round_in_progress, sem apagar nada e sem gravar linha', async () => {
      const fake = serve();
      fake.tables.set('automation_lock', [heldBy('cron', 4)]);
      seedDomain(fake);
      const response = await call({ body: confirm });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'round_in_progress' });
      expect(fake.rows('invoices')).toHaveLength(1);
      expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
      expect(fake.rows('automation_runs')).toHaveLength(0);
      expect(fake.rows('automation_lock')[0]).toMatchObject({ owner: 'cron' });
    });

    it('#356/AC-3 com a trava livre: toma uma vez só, apaga, a rodada corre com ela e a solta no fim', async () => {
      const fake = serve();
      seedDomain(fake);
      expect((await call({ body: confirm })).status).toBe(200);
      const takes = fake.requests.filter((r) => r.url.includes('rpc/take_automation_lock'));
      expect(takes).toHaveLength(1);
      const takeAt = fake.requests.indexOf(takes[0] as (typeof fake.requests)[number]);
      const firstDelete = fake.requests.findIndex((r) => r.method === 'DELETE');
      expect(takeAt).toBeLessThan(firstDelete);
      expect(fake.rows('automation_lock')).toHaveLength(0);
      expect(fake.rows('automation_runs')).toHaveLength(1);
      expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'ok', origin: 'manual' });
    });

    it('#356/AC-3 a trava vencida é tomada e a reconferência roda', async () => {
      const fake = serve();
      fake.tables.set('automation_lock', [heldBy('morta', -1)]);
      expect((await call({ body: confirm })).status).toBe(200);
      expect(fake.rows('automation_lock')).toHaveLength(0);
    });

    it('#356/AC-3 se o apagamento falha: 502 genérico e a trava é solta', async () => {
      const fake = serve();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fake.failNext('outbox_dock_actions', 'DELETE', 500, { message: 'segredo-do-banco' });
      fake.failNext('invoices', 'DELETE', 500, { message: 'segredo-do-banco' });
      const response = await call({ body: confirm });
      expect(response.status).toBe(502);
      expect(JSON.stringify(await response.json())).not.toContain('segredo-do-banco');
      expect(fake.rows('automation_lock')).toHaveLength(0);
    });
    it('#356/AC-3 se a leitura do modo falha depois de apagar: 502 genérico e a trava é solta, sem esperar a validade', async () => {
      const fake = serve();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      seedDomain(fake);
      fake.failNext('demo_settings', 'GET', 500, { message: 'segredo-do-banco' });
      const response = await call({ body: confirm });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'reconferir_failed' });
      expect(fake.rows('automation_lock')).toHaveLength(0);
      expect(fake.requests.filter((r) => r.url.includes('rpc/release_automation_lock'))).toHaveLength(1);
    });
  });

  // #356/AC-4 Os apagamentos do domínio gastam do mesmo orçamento de 50 subrequests da rodada.
  describe('#356/AC-4 o orçamento da reconferência', () => {
    it('#356/AC-4 a invocação inteira (trava, 9 apagamentos, rodada, gravação e soltura) gasta no máximo 50 subrequests', async () => {
      const fake = serve();
      const counter = countSubrequests(fake.fetch, 1000);
      vi.stubGlobal('fetch', counter.fetch);
      expect((await call({ body: confirm })).status).toBe(200);
      expect(counter.trail().filter((t) => t.startsWith('DELETE'))).toHaveLength(9);
      expect(counter.count()).toBeLessThanOrEqual(50);
      expect(fake.rows('automation_runs')).toHaveLength(1);
      expect(fake.rows('automation_lock')).toHaveLength(0);
      expect(counter.trail().at(-1)).toBe('POST rpc/release_automation_lock');
    });
  });
});
