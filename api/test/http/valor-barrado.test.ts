// GET /api/valor-barrado (#71, história #39): a rota protegida pelo Access que serve o painel.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorker } from '../../src/index.js';
import type { Env } from '../../src/env.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { accessEnv, accessKit, type AccessKit } from '../support/access-token.js';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const supabaseEnv: Env = {
  ...accessEnv,
  BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co',
  BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_teste',
};

let kit: AccessKit;
beforeAll(async () => {
  kit = await accessKit();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function call(
  path: string,
  options: { env?: Env; token?: boolean | string; method?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  const token = options.token ?? true;
  if (token !== false) headers.set('Cf-Access-Jwt-Assertion', token === true ? await kit.token() : token);
  const worker = createWorker({ verifier: kit.verifier });
  const request = new Request(`https://worker.test${path}`, { method: options.method ?? 'GET', headers });
  return worker.fetch(request, options.env ?? supabaseEnv, ctx);
}

function serve(seed: Record<string, Record<string, unknown>[]>): FakePostgrest {
  const fake = new FakePostgrest(seed);
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
}

const SEED = {
  proposals: [
    {
      id: 1, classification: 'E6', dock_action: { kind: 'recusar' }, amount_at_risk_cents: 120_000,
      state: 'aprovada', created_at: '2026-11-03T12:00:00+00:00',
    },
    {
      id: 2, classification: 'E1', dock_action: { kind: 'receber_parcial', lines: [] }, amount_at_risk_cents: 3_000,
      state: 'aguardando_aprovacao', created_at: '2026-11-04T12:00:00+00:00',
    },
    {
      id: 3, classification: 'E3', dock_action: { kind: 'receber' }, amount_at_risk_cents: 999,
      state: 'alterada', created_at: '2026-11-04T12:00:00+00:00',
    },
  ],
  approvals: [{ proposal_id: 1, approved_at: '2026-12-01T02:00:00+00:00' }],
};

describe('GET /api/valor-barrado', () => {
  it('#71 sem token recebe 401 do Access', async () => {
    const response = await call('/api/valor-barrado?mes=2026-11', { token: false });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
  });

  for (const mes of ['2026-13', '2026-1', 'novembro', '']) {
    it(`#71 mês malformado ${JSON.stringify(mes)} recebe 400`, async () => {
      const response = await call(`/api/valor-barrado?mes=${encodeURIComponent(mes)}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'mes_invalido' });
    });
  }

  it('#71 sem as credenciais do Supabase recebe 503', async () => {
    const response = await call('/api/valor-barrado?mes=2026-11', { env: accessEnv });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'supabase_nao_configurado' });
  });

  it('#71/AC-1 #71/AC-2 #71/AC-3 responde 200 com o barrado por exceção, a linha de base e o proposto', async () => {
    serve(SEED);
    const response = await call('/api/valor-barrado?mes=2026-11');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      month: '2026-11',
      baselineCents: 54_300_000,
      barred: { totalCents: 120_000, byException: [{ classification: 'E6', cents: 120_000, count: 1 }] },
      ifApprovedAsProposed: { totalCents: 3_000, byException: [{ classification: 'E1', cents: 3_000, count: 1 }] },
      daily: [
        { day: '2026-11-04', barredCumulativeCents: 0, proposedCumulativeCents: 3_000 },
        { day: '2026-11-30', barredCumulativeCents: 120_000, proposedCumulativeCents: 3_000 },
      ],
    });
  });

  it('#71 sem ?mes, usa o mês corrente em Brasília', async () => {
    // O verificador guarda o relógio real; o token é assinado antes de adiantar o Date.
    const token = await kit.token();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-01T02:30:00Z'));
    serve(SEED);
    const response = await call('/api/valor-barrado', { token });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { month: string; barred: { totalCents: number } };
    expect(body.month).toBe('2026-11');
    expect(body.barred.totalCents).toBe(120_000);
  });

  it('#71 MATCH que barra fica de fora e é registrado, sem derrubar a resposta', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serve({
      proposals: [
        {
          id: 7, classification: 'MATCH', dock_action: { kind: 'recusar' }, amount_at_risk_cents: 50,
          state: 'aprovada', created_at: '2026-11-03T12:00:00+00:00',
        },
      ],
      approvals: [],
    });
    const response = await call('/api/valor-barrado?mes=2026-11');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { barred: { totalCents: number } }).barred.totalCents).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('7');
  });

  it('#71 Supabase fora do ar responde 502 sem expor a chave', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => new Response('erro interno', { status: 500 }));
    const response = await call('/api/valor-barrado?mes=2026-11');
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: 'supabase_indisponivel' });
    expect(body).not.toContain('sb_secret_teste');
    expect(String(error.mock.calls[0]?.[0])).not.toContain('sb_secret_teste');
  });

  it('#71 só aceita GET', async () => {
    const response = await call('/api/valor-barrado', { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });
});
