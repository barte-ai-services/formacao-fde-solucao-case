// #356 O adaptador das portas da rodada sobre o SupabaseRest: o modo, a trava e a gravação, contra o PostgREST roteirizado e o fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_TTL_MS, runRound, type RoundBuild, type RoundPorts, type RoundRecord } from '../../src/automation/round.js';
import { ROUND_RESERVE } from '../../src/automation/round-budget.js';
import { supabaseRoundStore } from '../../src/automation/round-store.js';
import { NO_FIGURES, listRuns, listSkippedRuns } from '../../src/automation/runs.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { scripted, type Call, type Reply } from '../support/scripted-postgrest.js';
import { countSubrequests } from '../support/subrequest-counter.js';

const NO_TABLE = { code: 'PGRST205', message: "Could not find the table 'public.demo_settings' in the schema cache", hint: 'segredo-no-texto-do-provedor' };
const NO_FUNCTION = { code: 'PGRST202', message: 'Could not find the function public.take_automation_lock in the schema cache' };
const NO_COLUMN = { code: 'PGRST204', message: "Could not find the 'origin' column of 'automation_runs' in the schema cache" };
const NO_COLUMN_READ = { code: '42703', message: 'column automation_runs.deferred_steps does not exist' };

function storeOf(respond?: (call: Call) => Reply) {
  const { rest, calls } = scripted(respond);
  const logs: string[] = [];
  return { store: supabaseRoundStore({ rest, finish: rest, log: (l) => logs.push(l) }), calls, logs };
}

const RECORD: RoundRecord = {
  startedAt: new Date('2026-11-23T10:15:00Z'), finishedAt: new Date('2026-11-23T10:15:20Z'), status: 'ok', origin: 'manual',
  demoEnabled: true, figures: { ...NO_FIGURES, seen: 3 }, error: null, deferredSteps: ['dock'], failedSteps: ['claude'], subrequests: 31,
};

afterEach(() => vi.useRealTimers());

describe('#356/AC-1 o modo na leitura', () => { // ADR-002
  it('lê a linha única de demo_settings numa requisição', async () => { // ADR-002
    const { store, calls } = storeOf(() => ({ body: [{ enabled: true, changed_at: '2026-11-23T09:00:00+00:00' }] }));
    await expect(store.mode.read()).resolves.toEqual({ enabled: true, changedAt: '2026-11-23T09:00:00+00:00' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', table: 'demo_settings' });
    expect(calls[0]?.params.get('select')).toBe('enabled,changed_at');
    expect(calls[0]?.params.get('limit')).toBe('1');
  });

  it('sem linha, o modo é desligado', async () => { // ADR-002
    const { store } = storeOf();
    await expect(store.mode.read()).resolves.toEqual({ enabled: false, changedAt: null });
  });

  it('sem a tabela (migração não aplicada, PGRST205), o modo é desligado e a rodada não cai; o log traz só o fato', async () => { // ADR-002
    const { store, logs } = storeOf(() => ({ status: 404, body: NO_TABLE }));
    await expect(store.mode.read()).resolves.toEqual({ enabled: false, changedAt: null });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('demo_settings');
    expect(logs.join('\n')).not.toMatch(/segredo-no-texto|schema cache|PGRST/);
  });

  it('outra falha do banco sobe, não vira "desligado"', async () => { // ADR-002
    const { store } = storeOf(() => ({ status: 500, body: { code: 'XX000', message: 'boom' } }));
    await expect(store.mode.read()).rejects.toMatchObject({ status: 500 });
  });

  it('a linha fora do formato é erro de leitura, nunca um modo adivinhado', async () => { // ADR-002
    const { store } = storeOf(() => ({ body: [{ enabled: 'sim', changed_at: null }] }));
    await expect(store.mode.read()).rejects.toMatchObject({ operation: 'parse' });
  });
});

describe('#356/AC-2 o modo na escrita', () => { // ADR-002
  const CHANGE = { enabled: true, changedBy: 'ana@exemplo.test', changedAt: new Date('2026-11-23T10:00:00Z') };
  const SEED = { id: true, enabled: false, changed_by: null, changed_at: '2026-11-23T09:00:00+00:00', version: 3, history: [{ version: 3, at: '2026-11-23T09:00:00.000Z', by: null, enabled: false }] };
  const readThenPatch = (patched: unknown[] = [{ id: true }]) => (call: Call): Reply => ({ body: call.method === 'GET' ? [{ version: 3, history: SEED.history }] : patched });

  it('lê a versão e grava por PATCH filtrado por ela: uma leitura e uma gravação, sem upsert', async () => {
    const { store, calls } = storeOf(readThenPatch());
    await store.mode.write(CHANGE);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: 'GET', table: 'demo_settings' });
    expect(calls[0]?.params.get('select')).toBe('version,history');
    expect(calls[1]).toMatchObject({ method: 'PATCH', table: 'demo_settings' });
    expect(calls[1]?.params.get('id')).toBe('eq.true');
    expect(calls[1]?.params.get('version')).toBe('eq.3');
    expect(calls.some((c) => c.prefer.includes('merge-duplicates'))).toBe(false);
  });

  it('sobe a versão e acrescenta ao history {version, at, by, enabled}, sem apagar as entradas anteriores', async () => {
    const { store, calls } = storeOf(readThenPatch());
    await store.mode.write(CHANGE);
    expect(calls[1]?.body).toEqual({
      enabled: true, changed_by: 'ana@exemplo.test', changed_at: '2026-11-23T10:00:00.000Z', version: 4,
      history: [...SEED.history, { version: 4, at: '2026-11-23T10:00:00.000Z', by: 'ana@exemplo.test', enabled: true }],
    });
  });

  it('o service token (sem e-mail) grava o by nulo', async () => {
    const { store, calls } = storeOf(readThenPatch());
    await store.mode.write({ ...CHANGE, changedBy: null });
    expect((calls[1]?.body as { history: { by: unknown }[] }).history.at(-1)?.by).toBeNull();
  });

  it('o PATCH que não tocou linha (a versão andou) é recusado com o erro tipado de conflito', async () => {
    const { store } = storeOf(readThenPatch([]));
    await expect(store.mode.write(CHANGE)).rejects.toMatchObject({ name: 'DemoModeWriteError', reason: 'conflict' });
  });

  it('sem a linha (a migração semeia uma) é erro tipado, não recriação sem a condição', async () => {
    const { store, calls } = storeOf(() => ({ body: [] }));
    await expect(store.mode.write(CHANGE)).rejects.toMatchObject({ name: 'DemoModeWriteError', reason: 'missing' });
    expect(calls).toHaveLength(1);
  });

  it('o erro não leva o e-mail de quem mudou nem o history', async () => {
    const { store } = storeOf(readThenPatch([]));
    const error = await store.mode.write(CHANGE).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain('ana@exemplo.test');
    expect(JSON.stringify(error)).not.toContain('ana@exemplo.test');
  });

  it('o history fora do formato é erro de leitura, não uma gravação por cima', async () => {
    const { store, calls } = storeOf(() => ({ body: [{ version: 3, history: 'nada' }] }));
    await expect(store.mode.write(CHANGE)).rejects.toMatchObject({ operation: 'parse' });
    expect(calls).toHaveLength(1);
  });

  it('sem a tabela a escrita falha: não se finge ter ligado o modo', async () => { // ADR-002
    const { store } = storeOf(() => ({ status: 404, body: NO_TABLE }));
    await expect(store.mode.write({ enabled: true, changedBy: null, changedAt: new Date() })).rejects.toMatchObject({ status: 404 });
  });

  describe('contra o banco falso', () => { // ADR-002
    const make = () => {
      const fake = new FakePostgrest({ demo_settings: [{ ...SEED }] });
      const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
      return { fake, store: supabaseRoundStore({ rest, finish: rest, log: () => {} }) };
    };

    it('duas escritas sobre a mesma versão: a primeira grava, a segunda é conflito e não sobrescreve', async () => {
      const { fake, store } = make();
      const first = store.mode.write(CHANGE);
      const second = store.mode.write({ ...CHANGE, enabled: false, changedBy: 'bia@exemplo.test' });
      const results = await Promise.allSettled([first, second]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const row = fake.rows('demo_settings')[0] as { version: number; history: unknown[] };
      expect(row.version).toBe(4);
      expect(row.history).toHaveLength(2);
    });

    it('escritas em sequência andam a versão e guardam cada troca no history', async () => {
      const { fake, store } = make();
      await store.mode.write(CHANGE);
      await store.mode.write({ ...CHANGE, enabled: false, changedAt: new Date('2026-11-23T11:00:00Z') });
      const row = fake.rows('demo_settings')[0] as { version: number; enabled: boolean; history: { version: number }[] };
      expect(row.version).toBe(5);
      expect(row.enabled).toBe(false);
      expect(row.history.map((h) => h.version)).toEqual([3, 4, 5]);
    });
  });
});

describe('#356/AC-3 a trava', () => { // ADR-002
  it('toma por rpc, numa requisição, com dono e validade', async () => {
    const { store, calls } = storeOf(() => ({ body: true }));
    await expect(store.lock.take('dono-1', LOCK_TTL_MS)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', table: 'rpc/take_automation_lock', body: { p_owner: 'dono-1', p_valid_for_ms: LOCK_TTL_MS } });
  });

  it('com a trava de outro ainda válida, não toma', async () => { // ADR-002
    const { store } = storeOf(() => ({ body: false }));
    await expect(store.lock.take('dono-2', LOCK_TTL_MS)).resolves.toBe(false);
  });

  it('solta por rpc só a do dono, numa requisição', async () => { // ADR-002
    const { store, calls } = storeOf(() => ({ body: true }));
    await store.lock.release('dono-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: 'rpc/release_automation_lock', body: { p_owner: 'dono-1' } });
  });

  it('resposta que não é verdadeiro ou falso é erro de leitura', async () => { // ADR-002
    const { store } = storeOf(() => ({ body: 'talvez' }));
    await expect(store.lock.take('dono-1', LOCK_TTL_MS)).rejects.toMatchObject({ operation: 'parse' });
  });

  it('sem a função (migração não aplicada, PGRST202) a rodada segue sem trava, com uma linha de log, e soltar não gasta requisição', async () => { // ADR-002
    const { store, calls, logs } = storeOf(() => ({ status: 404, body: NO_FUNCTION }));
    await expect(store.lock.take('dono-1', LOCK_TTL_MS)).resolves.toBe(true);
    await store.lock.release('dono-1');
    expect(calls).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('sem trava');
    expect(logs.join('\n')).not.toMatch(/schema cache|PGRST/);
  });

  describe('contra o banco falso', () => { // ADR-002
    beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-23T10:00:00Z') }));
    const make = () => {
      const fake = new FakePostgrest();
      const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
      return { fake, store: supabaseRoundStore({ rest, finish: rest, log: () => {} }) };
    };

    it('a segunda rodada não toma enquanto a primeira vale; vencida, toma', async () => { // ADR-002
      const { store } = make();
      expect(await store.lock.take('a', LOCK_TTL_MS)).toBe(true);
      expect(await store.lock.take('b', LOCK_TTL_MS)).toBe(false);
      vi.setSystemTime(new Date('2026-11-23T10:05:01Z'));
      expect(await store.lock.take('b', LOCK_TTL_MS)).toBe(true);
    });

    it('soltar a trava de outro dono não a solta', async () => { // ADR-002
      const { store } = make();
      await store.lock.take('a', LOCK_TTL_MS);
      await store.lock.release('b');
      expect(await store.lock.take('c', LOCK_TTL_MS)).toBe(false);
      await store.lock.release('a');
      expect(await store.lock.take('c', LOCK_TTL_MS)).toBe(true);
    });
  });
});

describe('#356/AC-4 os adiados da última rodada que rodou', () => { // ADR-002
  it('lê deferred_steps da mais nova ok ou failed, sem a pulada, numa requisição', async () => {
    const { store, calls } = storeOf(() => ({ body: [{ deferred_steps: ['dock', 'claude'] }] }));
    await expect(store.history.lastDeferred()).resolves.toEqual(['dock', 'claude']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', table: 'automation_runs' });
    expect(calls[0]?.params.get('status')).toBe('in.(ok,failed)');
    expect(calls[0]?.params.get('order')).toBe('started_at.desc');
    expect(calls[0]?.params.get('limit')).toBe('1');
    expect(calls[0]?.params.get('select')).toBe('deferred_steps');
  });

  it('sem rodada, nada adiado; sem a coluna (42703), nada adiado', async () => { // ADR-002
    await expect(storeOf().store.history.lastDeferred()).resolves.toEqual([]);
    const { store } = storeOf(() => ({ status: 400, body: NO_COLUMN_READ }));
    await expect(store.history.lastDeferred()).resolves.toEqual([]);
  });
});

describe('#356 o estado corrente de automation_runs, remontado das linhas em qualquer ordem', () => { // ADR-002
  // rebuild_test de supabase/persistence-modes.yaml: as linhas ok, failed e skipped chegam fora de ordem.
  const row = (id: number, startedAt: string, status: 'ok' | 'failed' | 'skipped', deferred: string[]) => ({
    id, started_at: startedAt, finished_at: startedAt, status, origin: 'cron', demo_enabled: true, deferred_steps: deferred,
    seen: 1, inserted: 1, checked: 1, failed: 0, proposed: 1, approved_by_rule: 0, cadastro_e8: 0, dock_published: 0,
    store_published: 0, duplicates_blocked: 0, engine_evaluated: 0, engine_approved: 0, error: null,
  });
  const restOf = (rows: ReturnType<typeof row>[]) => {
    const fake = new FakePostgrest({ automation_runs: rows });
    return new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  };
  const SCRAMBLED = [
    row(2, '2026-11-23T10:15:00Z', 'ok', ['dock']),
    row(4, '2026-11-23T10:17:00Z', 'skipped', ['pulada']),
    row(1, '2026-11-23T10:00:00Z', 'failed', ['antigo']),
    row(3, '2026-11-23T10:16:00Z', 'failed', ['claude']),
  ];

  it('lastDeferred ignora a pulada mais nova e devolve os adiados da última que rodou', async () => {
    const store = supabaseRoundStore({ rest: restOf(SCRAMBLED), finish: restOf(SCRAMBLED), log: () => {} });
    await expect(store.history.lastDeferred()).resolves.toEqual(['claude']);
  });

  it('listRuns, de que o estado do painel parte, também só traz ok e failed, da mais nova à mais velha', async () => {
    expect((await listRuns(restOf(SCRAMBLED), 10)).map((r) => r.id)).toEqual([3, 2, 1]);
  });
});

describe('#356/AC-1 AC-3 a gravação da rodada', () => { // ADR-002
  it('grava as colunas de sempre mais a origem, o modo, os adiados, os passos falhos e o gasto', async () => {
    const { store, calls } = storeOf();
    await store.history.record(RECORD);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', table: 'automation_runs' });
    expect(calls[0]?.body).toEqual([expect.objectContaining({
      started_at: '2026-11-23T10:15:00.000Z', finished_at: '2026-11-23T10:15:20.000Z', status: 'ok', seen: 3, error: null,
      origin: 'manual', demo_enabled: true, deferred_steps: ['dock'], failed_steps: ['claude'], subrequests: 31,
    })]);
  });

  it('a rodada pulada grava skipped com a origem e o modo', async () => { // ADR-002
    const { store, calls } = storeOf();
    await store.history.record({ ...RECORD, status: 'skipped', origin: 'cron', demoEnabled: false, deferredSteps: [], failedSteps: [] });
    expect(calls[0]?.body).toEqual([expect.objectContaining({ status: 'skipped', origin: 'cron', demo_enabled: false })]);
  });

  it('sem as colunas novas (PGRST204) refaz uma vez sem elas: a linha não se perde', async () => { // ADR-002
    let first = true;
    const { store, calls } = storeOf(() => {
      if (first) { first = false; return { status: 400, body: NO_COLUMN }; }
      return { body: [] };
    });
    await store.history.record(RECORD);
    expect(calls).toHaveLength(2);
    const resent = (calls[1]?.body as Record<string, unknown>[])[0] ?? {};
    expect(resent).toMatchObject({ status: 'ok', seen: 3 });
    for (const column of ['origin', 'demo_enabled', 'deferred_steps', 'failed_steps', 'subrequests']) expect(resent).not.toHaveProperty(column);
  });

  it('a pulada não é refeita sem as colunas (o check antigo a recusaria): a falha sobe', async () => { // ADR-002
    const { store, calls } = storeOf(() => ({ status: 400, body: NO_COLUMN }));
    await expect(store.history.record({ ...RECORD, status: 'skipped' })).rejects.toMatchObject({ code: 'PGRST204' });
    expect(calls).toHaveLength(1);
  });

  it('outra falha do insert não é refeita', async () => { // ADR-002
    const { store, calls } = storeOf(() => ({ status: 500, body: { code: 'XX000', message: 'boom' } }));
    await expect(store.history.record(RECORD)).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(1);
  });
});

describe('#356/AC-5 as rodadas puladas e a lista que o painel já lê', () => { // ADR-002
  it('listRuns só pede ok e failed: a pulada não quebra a web de hoje', async () => {
    const { rest, calls } = scripted(() => ({ body: [] }));
    await listRuns(rest, 20);
    expect(calls[0]?.params.get('status')).toBe('in.(ok,failed)');
  });

  const NOW = new Date('2026-11-23T10:30:00Z');

  it('listSkippedRuns lê as puladas, da mais nova à mais velha, com origem e modo, só da janela recente', async () => { // ADR-002
    const { rest, calls } = scripted(() => ({ body: [{ id: 7, started_at: '2026-11-23T10:15:00+00:00', origin: 'manual', demo_enabled: true }] }));
    await expect(listSkippedRuns(rest, 10, NOW)).resolves.toEqual([{ id: 7, startedAt: '2026-11-23T10:15:00+00:00', origin: 'manual', demoEnabled: true }]);
    expect(calls[0]?.params.get('status')).toBe('eq.skipped');
    expect(calls[0]?.params.get('order')).toBe('started_at.desc');
    expect(calls[0]?.params.get('limit')).toBe('10');
    expect(calls[0]?.params.get('started_at')).toBe('gte.2026-11-22T10:30:00.000Z');
  });

  it('listSkippedRuns não lê a pulada de fora da janela, por mais que o limite sobre', async () => { // ADR-002
    const fake = new FakePostgrest({ automation_runs: [
      { id: 1, started_at: '2026-11-20T10:00:00Z', status: 'skipped', origin: 'cron', demo_enabled: true },
      { id: 2, started_at: '2026-11-23T10:00:00Z', status: 'skipped', origin: 'cron', demo_enabled: true },
    ] });
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    expect((await listSkippedRuns(rest, 10, NOW)).map((r) => r.id)).toEqual([2]);
  });

  it('sem as colunas novas (42703) não há puladas', async () => { // ADR-002
    const { rest } = scripted(() => ({ status: 400, body: NO_COLUMN_READ }));
    await expect(listSkippedRuns(rest, 10, NOW)).resolves.toEqual([]);
  });
});

describe('#356 a rodada inteira sobre o adaptador, dentro da reserva do orçamento', () => { // ADR-002
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-23T10:15:00Z') }));
  const build = (): RoundBuild => ({ steps: [], figures: () => NO_FIGURES, failsRound: new Set(), failedSteps: () => [] });

  function round(fake: FakePostgrest, owner: string) {
    const counter = countSubrequests(fake.fetch);
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: counter.fetch });
    const ports: RoundPorts = { ...supabaseRoundStore({ rest, finish: rest, log: () => {} }), buildRound: build, newOwner: () => owner, now: () => new Date(), log: () => {} };
    return { counter, ports };
  }

  it('rodada com a gravação refeita sem as colunas gasta no máximo a reserva (7) e solta a trava', async () => { // ADR-002
    const fake = new FakePostgrest();
    fake.failNext('automation_runs', 'POST', 400, NO_COLUMN);
    const { counter, ports } = round(fake, 'a');
    await expect(runRound(ports, { origin: 'manual' })).resolves.toMatchObject({ kind: 'done', status: 'ok' });
    expect(counter.count()).toBeLessThanOrEqual(ROUND_RESERVE);
    expect(fake.rows('automation_runs')).toHaveLength(1);
    expect(fake.rows('automation_lock')).toHaveLength(0);
  });

  it('com a trava tomada e válida a segunda rodada fica gravada como skipped, com origem e modo, e não toca na trava', async () => { // ADR-002
    const fake = new FakePostgrest({ demo_settings: [{ id: true, enabled: true, changed_at: null }] });
    const first = round(fake, 'a');
    await first.ports.lock.take('a', LOCK_TTL_MS);
    const second = round(fake, 'b');
    await expect(runRound(second.ports, { origin: 'manual' })).resolves.toEqual({ kind: 'locked' });
    expect(fake.rows('automation_runs')).toEqual([expect.objectContaining({ status: 'skipped', origin: 'manual', demo_enabled: true })]);
    expect(fake.rows('automation_lock')[0]?.owner).toBe('a');
  });

  it('a trava vencida (o Worker morreu) não impede a rodada seguinte', async () => { // ADR-002
    const fake = new FakePostgrest();
    await round(fake, 'a').ports.lock.take('a', LOCK_TTL_MS);
    vi.setSystemTime(new Date('2026-11-23T10:20:01Z'));
    await expect(runRound(round(fake, 'b').ports, { origin: 'manual' })).resolves.toMatchObject({ kind: 'done' });
  });

  it('antes da migração (sem tabela, função e colunas) a rodada roda, grava e não depende de nada novo', async () => { // ADR-002
    const fake = new FakePostgrest();
    fake.failNext('demo_settings', 'GET', 404, NO_TABLE);
    fake.failNext('rpc/take_automation_lock', 'POST', 404, NO_FUNCTION);
    fake.failNext('automation_runs', 'GET', 400, NO_COLUMN_READ);
    fake.failNext('automation_runs', 'POST', 400, NO_COLUMN);
    const { counter, ports } = round(fake, 'a');
    await expect(runRound(ports, { origin: 'manual' })).resolves.toMatchObject({ kind: 'done', status: 'ok' });
    expect(fake.rows('automation_runs')).toHaveLength(1);
    expect(counter.count()).toBeLessThanOrEqual(ROUND_RESERVE);
  });
});
