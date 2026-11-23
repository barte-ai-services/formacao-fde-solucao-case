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
const CRON = { cron: '* * * * *', scheduledTime: Date.parse('2026-11-23T10:15:00Z') };

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
    // #356 A rodada orquestrada lê antes o modo, toma a trava e lê os passos adiados: mais 3 antes da captura.
    const captured = cost + 1 + 3;
    const failing = failingAfter(fake, captured);
    vi.stubGlobal('fetch', failing.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const withAi: Env = { ...ENV, BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token', ai: {} as Ai };
    await expect(tick(CRON, withAi)).resolves.not.toBeNull();

    const runs = fake.rows('automation_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'ok', error: null });
    expect(runs[0]?.failed_steps).toEqual(
      // #356 Os nomes são os dos passos da rodada orçada (round-steps.ts) mais os que os helpers registram (round-helpers.ts).
      expect.arrayContaining(['propostas', 'dock', 'store', 'return-notes', 'duplicados', 'overdue-requests', 'claude']),
    );
    // #311 Os passos depois do que falhou ainda foram tentados: o fetch chegou às tabelas de cada um.
    const after = failing.trail.slice(captured).join('\n');
    // #311 O prazo dos pedidos (outbox_supplier_emails), a rodada do Claude (claude_suggestions) e a gravação da rodada.
    // #356 O motor, o último passo, não é admitido: o gasto medido das chamadas que falharam já não deixa lugar para o custo declarado dele.
    for (const call of ['GET outbox_supplier_emails', 'GET claude_suggestions', 'POST automation_runs']) {
      expect(after).toContain(call);
    }
    // #311 Cada passo que lê as propostas (E8, doca, loja, devoluções) tentou a leitura em vez de abortar a rodada no primeiro.
    // #356 A rodada orçada executa só os passos que cabem nos 50 (os outros ficam adiados): ao menos 3 deles leem as propostas.
    expect(failing.trail.slice(captured).filter((c) => c === 'GET proposals').length).toBeGreaterThanOrEqual(3);
    // #311 O log traz só a classe ou o status, nunca o texto do erro.
    const lines = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).not.toContain('fetch failed');
    expect(lines).not.toContain('falha de rede');
  });

  it('#356 a rodada quieta cabe nos 50 subrequests, a gravação e a soltura da trava incluídas, sem passo falho, e GRAVA a linha', async () => {
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
    expect(last).toMatchObject({ status: 'ok', error: null, failed_steps: [] });
    expect(counter.count()).toBeLessThanOrEqual(50);
    // #356 A gravação conta a si mesma; a soltura da trava vem depois dela.
    expect(last?.subrequests).toBe(counter.count() - 1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.startsWith('cron: subrequests'))).toEqual([`cron: subrequests ${counter.count()}/50 (tick * * * * *)`]);
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

    await tick(CRON, ENV);

    expect(fake.rows('automation_runs')[0]?.failed_steps).toEqual([]);
  });
});
