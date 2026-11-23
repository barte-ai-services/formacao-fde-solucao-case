// #356 AC-1 AC-3 AC-4 O tick (o Cron de minuto) ligado à rodada orquestrada: o ritmo do modo, a trava, o orçamento e a gravação,
// #356 contra o PostgREST falso. Um medidor por invocação: tudo o que sai do Worker na rodada passa por ele.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick, runManualRound } from '../../src/cron/tick.js';
import type { Env } from '../../src/env.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { countSubrequests } from '../support/subrequest-counter.js';

const ENV: Env = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
const at = (hhmm: string) => ({ cron: '* * * * *', scheduledTime: Date.parse(`2026-11-23T${hhmm}:00Z`) });
const DEMO_ON = { id: true, enabled: true, changed_at: '2026-11-23T09:00:00+00:00' };
const DEMO_OFF = { id: true, enabled: false, changed_at: '2026-11-23T09:00:00+00:00' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function world(demo?: Record<string, unknown>) {
  const fake = new FakePostgrest({ ...kitTables(), ...(demo ? { demo_settings: [demo] } : {}) });
  const counter = countSubrequests(fake.fetch, 1000);
  vi.stubGlobal('fetch', counter.fetch);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return { fake, counter, log };
}

const pathsOf = (fake: FakePostgrest) => fake.requests.map((r) => `${r.method} ${new URL(r.url).pathname.replace('/rest/v1/', '')}`);

describe('#356/AC-1 o tick segue o ritmo do modo', () => { // ADR-002
  it('#356/AC-1 modo desligado, 10:07: lê o modo e sai, sem gravar linha e sem outra subrequest', async () => {
    const { fake, counter } = world(DEMO_OFF);
    await expect(tick(at('10:07'), ENV)).resolves.toBeNull();
    expect(pathsOf(fake)).toEqual(['GET demo_settings']);
    expect(counter.count()).toBe(1);
    expect(fake.rows('automation_runs')).toEqual([]);
  });

  it('#356/AC-1 modo desligado, 10:15: a rodada roda, de origem cron, e grava o modo', async () => {
    const { fake } = world(DEMO_OFF);
    await tick(at('10:15'), ENV);
    expect(fake.rows('automation_runs')).toHaveLength(1);
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'ok', origin: 'cron', demo_enabled: false });
  });

  it('#356/AC-1 modo ligado, em qualquer minuto: a rodada roda e grava o modo ligado', async () => {
    for (const minute of ['10:07', '10:08', '10:15']) {
      const { fake } = world(DEMO_ON);
      await tick(at(minute), ENV);
      expect(fake.rows('automation_runs'), minute).toHaveLength(1);
      expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'ok', origin: 'cron', demo_enabled: true });
    }
  });

  it('#356/AC-1 sem a tabela demo_settings (migração não aplicada) o modo é desligado: 10:07 sai e 10:15 roda, sem derrubar a rodada', async () => {
    const fake = new FakePostgrest(kitTables());
    const noTable = (input: string, init?: RequestInit) =>
      input.includes('/demo_settings')
        ? Promise.resolve(new Response(JSON.stringify({ code: 'PGRST205', message: 'Could not find the table' }), { status: 404 }))
        : fake.fetch(input, init);
    vi.stubGlobal('fetch', noTable);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(tick(at('10:07'), ENV)).resolves.toBeNull();
    expect(fake.rows('automation_runs')).toEqual([]);
    await tick(at('10:15'), ENV);
    expect(fake.rows('automation_runs')).toHaveLength(1);
  });

  it('#356/AC-1 com NADA da migração aplicada (modo, trava e colunas novas), a rodada roda e grava a linha de antes', async () => {
    const fake = new FakePostgrest(kitTables());
    const missing = (code: string) => Promise.resolve(new Response(JSON.stringify({ code, message: 'texto-do-provedor' }), { status: code === 'PGRST204' ? 400 : 404 }));
    const before = (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (input.includes('/demo_settings')) return missing('PGRST205');
      if (input.includes('/rpc/take_automation_lock')) return missing('PGRST202');
      if (input.includes('/automation_runs') && method === 'GET' && input.includes('deferred_steps')) return missing('42703');
      if (input.includes('/automation_runs') && method === 'POST' && String(init?.body).includes('"origin"')) return missing('PGRST204');
      return fake.fetch(input, init);
    };
    vi.stubGlobal('fetch', before);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(tick(at('10:15'), ENV)).resolves.not.toBeNull();
    expect(fake.rows('automation_runs')).toHaveLength(1);
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'ok' });
    expect(fake.rows('automation_runs')[0]).not.toHaveProperty('origin');
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/PGRST|texto-do-provedor/);
  });

  it('#356/AC-1 sem as credenciais do Supabase o tick registra uma linha e volta, sem rede', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(tick(at('10:15'), {} as Env)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('#356/AC-3 a trava no tick', () => { // ADR-002
  const LOCKED = { id: true, owner: 'outra-rodada', expires_at: '2026-11-23T10:20:00.000Z' };

  it('#356/AC-3 com a trava tomada e válida o tick não roda passo nenhum e grava a linha skipped, com a origem e o modo', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T10:15:30Z'));
    const { fake } = world(DEMO_ON);
    fake.tables.set('automation_lock', [{ ...LOCKED }]);
    await expect(tick(at('10:15'), ENV)).resolves.toBeNull();
    expect(pathsOf(fake)).toEqual(['GET demo_settings', 'POST rpc/take_automation_lock', 'POST automation_runs']);
    expect(fake.rows('automation_runs')).toHaveLength(1);
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'skipped', origin: 'cron', demo_enabled: true });
    expect(fake.rows('automation_lock')[0]).toMatchObject({ owner: 'outra-rodada' });
    vi.useRealTimers();
  });

  it('#356/AC-3 a trava vencida não impede a rodada seguinte: ela toma a trava, roda e solta', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T10:30:00Z'));
    const { fake } = world(DEMO_ON);
    fake.tables.set('automation_lock', [{ ...LOCKED }]);
    await tick(at('10:30'), ENV);
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'ok' });
    expect(fake.rows('automation_lock')).toEqual([]);
    vi.useRealTimers();
  });

  it('#356/AC-3 a rodada manual também pula com a trava tomada, de origem manual', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T10:15:30Z'));
    const { fake } = world(DEMO_OFF);
    fake.tables.set('automation_lock', [{ ...LOCKED }]);
    await expect(runManualRound(ENV)).resolves.toMatchObject({ kind: 'locked' });
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'skipped', origin: 'manual' });
    vi.useRealTimers();
  });

  it('#356/AC-3 a rodada manual roda fora do ritmo (10:07), de origem manual', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T10:07:30Z'));
    const { fake } = world(DEMO_OFF);
    await expect(runManualRound(ENV)).resolves.toMatchObject({ kind: 'done', status: 'ok' });
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'ok', origin: 'manual' });
    vi.useRealTimers();
  });
});

describe('#356/AC-4 a rodada do tick cabe nos 50 subrequests, com um medidor só', () => { // ADR-002
  it('#356/AC-4 o gasto medido, fetch a fetch, não passa de 50; o que não coube é gravado e a rodada seguinte o executa', async () => {
    const first = world(DEMO_ON);
    await tick(at('10:00'), ENV);
    expect(first.counter.count()).toBeLessThanOrEqual(50);
    const run1 = first.fake.rows('automation_runs')[0];
    // A gravação conta a si mesma; a soltura da trava vem depois dela e é a única subrequest fora do número gravado.
    expect(run1?.subrequests).toBe(first.counter.count() - 1);
    const deferred = run1?.deferred_steps as string[];
    expect(deferred.length).toBeGreaterThan(0);

    // A mesma base na rodada seguinte: o adiado passa à frente e roda.
    const fake = first.fake;
    const counter = countSubrequests(fake.fetch, 1000);
    vi.stubGlobal('fetch', counter.fetch);
    await tick(at('10:01'), ENV);
    expect(counter.count()).toBeLessThanOrEqual(50);
    const run2 = fake.rows('automation_runs')[1];
    expect(run2?.deferred_steps as string[]).not.toContain(deferred[0]);
  });

  it('#356/AC-4 a rodada que falha na captura grava failed, com a classe do erro, e o erro sobe', async () => {
    const fake = new FakePostgrest({ ...kitTables(), demo_settings: [DEMO_ON] });
    const failing = (input: string, init?: RequestInit) =>
      input.includes('/invoices') ? Promise.resolve(new Response('{"message":"segredo"}', { status: 500 })) : fake.fetch(input, init);
    vi.stubGlobal('fetch', failing);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(tick(at('10:15'), ENV)).rejects.toThrow();
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'failed', error: 'SupabaseRestError' });
    expect(JSON.stringify(fake.rows('automation_runs')[0])).not.toContain('segredo');
    expect(fake.rows('automation_lock')).toEqual([]);
  });
});
