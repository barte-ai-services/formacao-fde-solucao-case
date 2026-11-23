// #311 Cenário A: o tick de 15 minutos termina mesmo quando o fetch passa a falhar (status 0, o padrão do teto de 50
// #311 subrequests por invocação), cada passo periférico falho fica registrado e a linha de automation_runs é sempre gravada.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { tick } from '../../src/cron/tick.js';
import type { Env } from '../../src/env.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { countSubrequests, UNCAPPED } from '../support/subrequest-counter.js';

const ENV: Env = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
const CRON = { cron: '*/15 * * * *' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** #311 Quantos subrequests a captura (o caminho crítico) gasta sozinha sobre o kit: o N a partir do qual o fetch falha. */
async function captureCost(): Promise<number> {
  const fake = new FakePostgrest(kitTables());
  const counter = countSubrequests(fake.fetch, 1000);
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: counter.fetch });
  await captureInvoices(supabaseConnectors(rest).captureDeps);
  return counter.count();
}

/** #311 O fetch que responde normal até o N-ésimo subrequest e depois falha como falha de rede; só a gravação da rodada passa. */
function failingAfter(fake: FakePostgrest, n: number) {
  const trail: string[] = [];
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    trail.push(`${init?.method ?? 'GET'} ${new URL(input).pathname.replace('/rest/v1/', '')}`);
    if (input.includes('/automation_runs')) return fake.fetch(input, init);
    if (trail.length > n) return Promise.reject(new TypeError('fetch failed'));
    return fake.fetch(input, init);
  };
  return { fetch, trail };
}

describe('#311 a rodada resiliente', () => {
  it('com o fetch falhando depois da captura, o tick resolve, grava a rodada com os passos falhos e tenta os passos seguintes', async () => {
    const fake = new FakePostgrest(kitTables());
    const cost = await captureCost();
    // #311 A leitura das sugestões do Claude vem antes da captura e gasta 1: a captura termina no subrequest cost + 1.
    const captured = cost + 1;
    const failing = failingAfter(fake, captured);
    vi.stubGlobal('fetch', failing.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const withAi: Env = { ...ENV, BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token', ai: {} as Ai };
    await expect(tick(CRON, withAi)).resolves.not.toBeNull();

    const runs = fake.rows('automation_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'ok', error: null });
    expect(runs[0]?.failed_steps).toEqual(
      expect.arrayContaining(['proposals', 'registry-e8', 'dock', 'store', 'return-notes', 'duplicate-titles', 'overdue-requests', 'claude', 'engine']),
    );
    // #311 Os passos depois do que falhou ainda foram tentados: o fetch chegou às tabelas de cada um.
    const after = failing.trail.slice(captured).join('\n');
    // #311 O prazo dos pedidos (outbox_supplier_emails), a rodada do Claude (claude_suggestions), o motor (engine_settings) e a gravação da rodada.
    for (const call of ['GET outbox_supplier_emails', 'GET claude_suggestions', 'GET engine_settings', 'POST automation_runs']) {
      expect(after).toContain(call);
    }
    // #311 Cada passo que lê as propostas (E8, doca, loja, devoluções) tentou a leitura em vez de abortar a rodada no primeiro.
    expect(failing.trail.slice(captured).filter((c) => c === 'GET proposals').length).toBeGreaterThanOrEqual(4);
    // #311 O log traz só a classe ou o status, nunca o texto do erro.
    const lines = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).not.toContain('fetch failed');
    expect(lines).not.toContain('falha de rede');
  });

  it('com o teto de 50 subrequests, a gravação incluída, a rodada quieta termina, pula o que não coube e GRAVA a linha', async () => {
    const fake = new FakePostgrest(kitTables());
    vi.stubGlobal('fetch', fake.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await tick(CRON, ENV);
    const before = fake.rows('automation_runs').length;
    log.mockClear();
    const counter = countSubrequests(fake.fetch, 50);
    vi.stubGlobal('fetch', counter.fetch);

    await expect(tick(CRON, ENV)).resolves.not.toBeNull();

    const runs = fake.rows('automation_runs');
    expect(runs).toHaveLength(before + 1);
    const last = runs[runs.length - 1];
    expect(last).toMatchObject({ status: 'ok', error: null });
    expect(last?.failed_steps).not.toEqual([]);
    expect(counter.count()).toBeLessThanOrEqual(50);
    expect(last?.subrequests).toBe(counter.count());
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.startsWith('cron: orçamento de subrequests esgotado'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('cron: subrequests'))).toEqual([`cron: subrequests ${counter.count()}/50 (tick */15 * * * *)`]);
  });

  it('a captura segue no caminho crítico: falha nela ainda é rodada failed e o erro sobe', async () => {
    const fake = new FakePostgrest(kitTables());
    const failing = failingAfter(fake, 2);
    vi.stubGlobal('fetch', failing.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(tick(CRON, ENV)).rejects.toThrow();

    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'failed', error: 'SupabaseRestError' });
  });

  it('a rodada sem falha grava failed_steps vazio', async () => {
    const fake = new FakePostgrest(kitTables());
    vi.stubGlobal('fetch', fake.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await tick(CRON, ENV, UNCAPPED);

    expect(fake.rows('automation_runs')[0]?.failed_steps).toEqual([]);
  });
});
