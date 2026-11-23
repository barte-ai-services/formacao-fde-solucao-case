// #356 AC-5 GET /api/automacao com o modo demonstração, a próxima rodada no ritmo do modo, as rodadas puladas e o papel de quem pede.
// #356 O contrato é escrito à mão (api/README.md, seção da automação, e CONTRACT abaixo) e a resposta é validada contra ele; a web de hoje
// #356 (web/src/api/automation.ts) só conhece `state`, `last`, `next`, `runs` e `indicators`, e esses seguem com o formato de antes.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorker } from '../../src/index.js';
import type { Env } from '../../src/env.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { accessEnv, accessKit, type AccessKit } from '../support/access-token.js';

const ADMIN = 'cfo@jachegou.test';
const env: Env = {
  ...accessEnv,
  BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co',
  BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_teste',
  BARTE_ACADEMY_ADMIN_EMAILS: JSON.stringify([ADMIN]),
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

let admin: AccessKit;
let analyst: AccessKit;
beforeAll(async () => {
  admin = await accessKit(ADMIN);
  analyst = await accessKit('analista@jachegou.test');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const run = (id: number, startedAt: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, started_at: startedAt, finished_at: startedAt, status, seen: 12, inserted: 12, checked: 12, failed: 0, proposed: 11,
  approved_by_rule: 7, cadastro_e8: 0, dock_published: 5, store_published: 0, duplicates_blocked: 0, engine_evaluated: 0, engine_approved: 0,
  error: null, ...extra,
});

async function get(tables: Record<string, Record<string, unknown>[]>, who: AccessKit = admin, now = '2026-11-23T10:18:30Z'): Promise<Record<string, unknown>> {
  // O verificador do Access lê o relógio real: o token sai antes de o teste fixar a data.
  vi.useRealTimers();
  const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await who.token() });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  vi.stubGlobal('fetch', new FakePostgrest(tables).fetch);
  const response = await createWorker({ verifier: who.verifier }).fetch(new Request('https://worker.test/api/automacao', { headers }), env, ctx);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

const ON = { id: true, enabled: true, changed_by: 'cfo@jachegou.test', changed_at: '2026-11-23T09:00:00+00:00', version: 2, history: [{ by: 'cfo@jachegou.test' }] };
const OFF = { ...ON, enabled: false };

describe('#356/AC-5 o modo e a próxima rodada no ritmo do modo', () => { // ADR-002
  it('#356/AC-5 modo ligado: demo ligado, intervalo de 1 minuto e `next` no minuto seguinte', async () => {
    const body = await get({ demo_settings: [ON] });
    expect(body.demo).toEqual({ enabled: true, changedAt: '2026-11-23T09:00:00+00:00' });
    expect(body.intervalMinutes).toBe(1);
    expect(body.next).toBe('2026-11-23T10:19:00.000Z');
  });

  it('#356/AC-5 modo desligado: intervalo de 15 minutos e `next` no próximo múltiplo de 15', async () => {
    const body = await get({ demo_settings: [OFF] });
    expect(body.demo).toEqual({ enabled: false, changedAt: '2026-11-23T09:00:00+00:00' });
    expect(body.intervalMinutes).toBe(15);
    expect(body.next).toBe('2026-11-23T10:30:00.000Z');
  });

  it('#356/AC-5 sem demo_settings (migração não aplicada): modo desligado, 15 minutos, sem erro', async () => {
    const body = await get({ automation_runs: [run(1, '2026-11-23T10:15:00Z', 'ok')] });
    expect(body.demo).toEqual({ enabled: false, changedAt: null });
    expect(body.intervalMinutes).toBe(15);
    expect(body.skipped).toEqual([]);
  });

  it('#356/AC-5 nunca devolve o e-mail de quem mudou o modo, nem o history', async () => {
    const body = await get({ demo_settings: [ON] }, analyst);
    const text = JSON.stringify(body);
    expect(text).not.toContain('cfo@jachegou.test');
    expect(text).not.toContain('history');
    expect(text).not.toContain('changed_by');
  });
});

describe('#356/AC-5 as rodadas puladas e o papel de quem pede', () => { // ADR-002
  const tables = {
    demo_settings: [OFF],
    automation_runs: [
      run(3, '2026-11-23T10:16:00Z', 'skipped', { origin: 'manual', demo_enabled: false }),
      run(2, '2026-11-23T10:15:00Z', 'ok', { origin: 'cron', demo_enabled: false }),
      run(1, '2026-11-23T10:00:00Z', 'failed', { origin: 'cron', demo_enabled: false }),
    ],
  };

  it('#356/AC-5 as puladas vão num campo próprio; `last` e `runs` seguem só com ok e failed, no formato de antes', async () => {
    const body = await get(tables);
    expect(body.skipped).toEqual([{ id: 3, startedAt: '2026-11-23T10:16:00Z', origin: 'manual', demoEnabled: false }]);
    expect((body.runs as { id: number; status: string }[]).map((r) => [r.id, r.status])).toEqual([[2, 'ok'], [1, 'failed']]);
    expect(body.last).toMatchObject({ id: 2, status: 'ok' });
    expect(body.state).toBe('ok');
  });

  it('#356/AC-5 a rodada pulada não esconde uma parada: só puladas há mais de 45 minutos, o estado é stalled', async () => {
    const body = await get(tables, admin, '2026-11-23T11:30:00Z');
    expect(body.state).toBe('stalled');
  });

  it('#356/AC-5 isAdmin é verdadeiro para o administrador e falso para os demais', async () => {
    expect((await get(tables, admin)).isAdmin).toBe(true);
    expect((await get(tables, analyst)).isAdmin).toBe(false);
  });
});

// #356 AC-5 O contrato escrito à mão: os campos de topo da resposta, o que cada um é e o que a web de hoje lê.
const CONTRACT = {
  top: ['state', 'last', 'next', 'runs', 'indicators', 'demo', 'intervalMinutes', 'skipped', 'isAdmin'],
  legacy: ['state', 'last', 'next', 'runs', 'indicators'],
  demo: ['enabled', 'changedAt'],
  skipped: ['id', 'startedAt', 'origin', 'demoEnabled'],
} as const;

describe('#356/AC-5 a resposta cumpre o contrato escrito no README', () => { // ADR-002
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('GET /api/automacao'));

  it('#356/AC-5 a resposta tem exatamente os campos do contrato, e o demo e as puladas têm os campos dele', async () => {
    const body = await get({
      demo_settings: [ON],
      automation_runs: [run(2, '2026-11-23T10:16:00Z', 'skipped', { origin: 'cron', demo_enabled: true }), run(1, '2026-11-23T10:15:00Z', 'ok')],
    });
    expect(Object.keys(body).sort()).toEqual([...CONTRACT.top].sort());
    expect(Object.keys(body.demo as object).sort()).toEqual([...CONTRACT.demo].sort());
    expect(Object.keys((body.skipped as object[])[0] ?? {}).sort()).toEqual([...CONTRACT.skipped].sort());
    expect(typeof body.isAdmin).toBe('boolean');
    expect(typeof body.intervalMinutes).toBe('number');
  });

  it('#356/AC-5 o README documenta a rota, cada campo da resposta e as duas rotas de administração', () => {
    expect(readme).toContain('GET /api/automacao');
    for (const field of [...CONTRACT.top, ...CONTRACT.demo, ...CONTRACT.skipped]) expect(section, field).toContain(`\`${field}\``);
    expect(readme).toContain('POST /api/admin/rodar-agora');
    expect(readme).toContain('POST /api/admin/modo-demonstracao');
    expect(readme).toContain('`{ "enabled": true }`');
    for (const status of ['202', '403', '409']) expect(readme).toContain(status);
  });

  it('#356/AC-5 a web de hoje continua lendo os mesmos campos, com o mesmo formato', () => {
    const web = readFileSync(new URL('../../../web/src/api/automation.ts', import.meta.url), 'utf8');
    for (const field of CONTRACT.legacy) expect(web, field).toContain(field);
    expect(web).toMatch(/status: ['"]ok['"] \| ['"]failed['"]/);
  });
});
