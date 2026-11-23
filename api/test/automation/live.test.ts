// #354 GET /api/live: os passos da automação do mais novo ao mais velho e os indicadores do dia.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import { SupabaseApprovalStore } from '../../src/approval/supabase-store.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

const ENV = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
const env: Env = { ...ENV, ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com' };
// #354 O Worker só lê `waitUntil` do contexto; o resto do ExecutionContext não entra no que estes testes exercitam.
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const verifier: AccessVerifier = { verify: async (token) => ({ ok: true, identity: { email: token } }) };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const KEY_A = '35261100000000000100550010000000011000000011';
const KEY_B = '35261100000000000100550010000000021000000022';
const KEY_C = '35261100000000000100550010000000031000000033';

const call = (fake: FakePostgrest, path = '/api/live', token: string | null = 'ana@jachegou.test', e: Env = env) => {
  vi.stubGlobal('fetch', fake.fetch);
  const headers = new Headers();
  if (token) headers.set('Cf-Access-Jwt-Assertion', token);
  return createWorker({ verifier }).fetch(new Request(`https://worker.test${path}`, { headers }), e, ctx);
};

const run = (id: number, startedAt: string, status: 'ok' | 'failed' = 'ok') => ({
  id, started_at: startedAt, finished_at: startedAt, status, seen: 12, inserted: 12, checked: 12, failed: 0,
  proposed: 11, approved_by_rule: 7, cadastro_e8: 0, dock_published: 5, store_published: 0, duplicates_blocked: 0,
  engine_evaluated: 0, engine_approved: 0, error: status === 'failed' ? 'SupabaseRestError' : null,
});
const decision = (key: string, decidedAt: string, over: Record<string, unknown> = {}) => ({
  invoice_access_key: key, outcome: 'approve', decided_by: 'clef', confidence: 0.97, model_version: 'v1', mode: 'shadow',
  role: 'cascade', reason: 'dentro dos critérios', pending_reason: null, error: null, latency_ms: 200, recommendation: null,
  decided_at: decidedAt, ...over,
});

/** #354 O mundo do cenário: uma rodada, três decisões do motor/regra e uma decisão de pessoa, em horas diferentes. */
const world = () => ({
  automation_runs: [run(1, '2026-11-16T13:15:00.000Z')],
  engine_decisions: [
    decision(KEY_A, '2026-11-16T13:16:00.000Z'),
    decision(KEY_B, '2026-11-16T13:17:00.000Z', { decided_by: 'rule', mode: 'delegated' }),
    decision(KEY_C, '2026-11-16T13:18:00.000Z', { role: 'benchmark' }),
    decision(KEY_C, '2026-11-16T13:19:00.000Z', { decided_by: 'person', outcome: 'pending', pending_reason: 'below_confidence' }),
  ],
  proposals: [
    { id: 1, invoice_access_key: KEY_A, created_at: 'x' },
    { id: 2, invoice_access_key: KEY_B, created_at: 'x' },
    { id: 3, invoice_access_key: KEY_C, created_at: 'x' },
  ],
  invoices: [
    { access_key: KEY_A, number: '101', captured_at: '2026-11-16T13:00:00Z' },
    { access_key: KEY_B, number: '102', captured_at: '2026-11-16T13:00:00Z' },
    { access_key: KEY_C, number: '103', captured_at: '2026-11-16T13:00:00Z' },
  ],
  approvals: [
    { proposal_id: 1, approver: 'regra', approver_level: 'regra', approved_at: '2026-11-16T13:16:30.000Z' },
    { proposal_id: 2, approver: 'motor', approver_level: 'analista', approved_by: 'engine', approved_at: '2026-11-16T13:17:30.000Z' },
    { proposal_id: 3, approver: 'ana@jachegou.test', approver_level: 'analista', approved_at: '2026-11-16T13:20:00.000Z' },
  ],
});

type Body = { events: Record<string, unknown>[]; since: string | null; indicators: { day: Record<string, unknown>; month: Record<string, unknown> }; awaiting: number };

describe('#354/AC-1 GET /api/live devolve os passos, do mais novo ao mais velho', () => {
  it('#354/AC-1 Dado rodada, decisões do motor e aprovação de pessoa, os eventos vêm do mais novo ao mais velho, cada um com kind, hora, quem fez e a nota', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T15:00:00Z'));
    const res = await call(new FakePostgrest(world()));
    const body = (await res.json()) as Body;
    expect(res.status).toBe(200);
    expect(body.events.map((e) => [e.kind, e.at, e.actor, e.actor_name, (e.invoice as { number: string } | null)?.number ?? null])).toEqual([
      ['human_decision', '2026-11-16T13:20:00.000Z', 'person', 'ana@jachegou.test', '103'],
      ['decision', '2026-11-16T13:17:00.000Z', 'rule', 'Regra', '102'],
      ['decision', '2026-11-16T13:16:00.000Z', 'engine', 'Motor', '101'],
      ['run', '2026-11-16T13:15:00.000Z', 'system', 'Automático', null],
    ]);
    expect(body.since).toBe('2026-11-16T13:20:00.000Z');
  });

  it('#354/AC-1 o passo diz em português o que aconteceu, e a decisão em sombra diz o que o motor faria', async () => {
    const body = (await (await call(new FakePostgrest(world()))).json()) as Body;
    const step = (kind: string, n: string | null) =>
      body.events.find((e) => e.kind === kind && ((e.invoice as { number: string } | null)?.number ?? null) === n)?.step;
    expect(step('run', null)).toBe('Rodada: 12 vistas, 11 propostas, 7 pela regra');
    expect(step('decision', '101')).toBe('Motor, em sombra, aprovaria');
    expect(step('decision', '102')).toBe('Regra aprovou');
  });

  it('#354/AC-1 a rodada que falhou diz a classe do erro', async () => {
    const body = (await (await call(new FakePostgrest({ automation_runs: [run(1, '2026-11-16T13:15:00.000Z', 'failed')] }))).json()) as Body;
    expect(body.events[0]).toMatchObject({ kind: 'run', status: 'failed', step: 'Rodada falhou: SupabaseRestError' });
  });

  it('#354/AC-1 só a cascata entra, e a decisão que já é de pessoa não conta duas vezes (a pessoa vem de approvals)', async () => {
    const body = (await (await call(new FakePostgrest(world()))).json()) as Body;
    expect(body.events.filter((e) => e.kind === 'decision')).toHaveLength(2);
    expect(body.events.filter((e) => e.kind === 'human_decision')).toHaveLength(1);
  });

  it('#354/AC-1 devolve no máximo os 50 eventos mais novos', async () => {
    const runs = Array.from({ length: 60 }, (_, i) => run(i + 1, new Date(Date.parse('2026-11-16T10:00:00Z') + i * 60_000).toISOString()));
    const body = (await (await call(new FakePostgrest({ automation_runs: runs }))).json()) as Body;
    expect(body.events).toHaveLength(50);
    expect(body.events[0]?.at).toBe('2026-11-16T10:59:00.000Z');
  });

  it('#354/AC-1 dois eventos na mesma hora saem sempre na mesma ordem', async () => {
    const at = '2026-11-16T13:16:00.000Z';
    const fake = () => new FakePostgrest({ automation_runs: [run(1, at)], engine_decisions: [decision(KEY_A, at), decision(KEY_B, at)], invoices: [] });
    const first = ((await (await call(fake())).json()) as Body).events.map((e) => e.kind);
    const second = ((await (await call(fake())).json()) as Body).events.map((e) => e.kind);
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
  });
});

describe('#354/AC-2 since devolve só o que foi gravado depois', () => {
  it('#354/AC-2 Dado que a tela tem os eventos até T, pedir since=T traz só os mais novos, e o filtro vai na consulta', async () => {
    const fake = new FakePostgrest(world());
    const res = await call(fake, `/api/live?since=${encodeURIComponent('2026-11-16T13:16:00.000Z')}`);
    const body = (await res.json()) as Body;
    expect(res.status).toBe(200);
    expect(body.events.map((e) => e.at)).toEqual(['2026-11-16T13:20:00.000Z', '2026-11-16T13:17:00.000Z']);
    // #354 As quatro leituras dos passos (a #353 acrescentou os pedidos enviados sozinhos) são as que pedem o teto de 50 e a ordem do mais novo; cada uma leva o gt no banco.
    const reads = fake.requests.filter((r) => r.method === 'GET' && r.url.includes('limit=50'));
    expect(reads.map((r) => new URL(r.url).pathname.split('/').pop()).sort()).toEqual(['approvals', 'automation_runs', 'engine_decisions', 'outbox_supplier_emails']);
    expect(reads.every((r) => /(started_at|decided_at|approved_at|sent_at)=gt\./.test(decodeURIComponent(r.url)))).toBe(true);
  });

  it('#354/AC-2 sem nada novo, os eventos vêm vazios e since devolve o mesmo cursor', async () => {
    const body = (await (await call(new FakePostgrest(world()), `/api/live?since=${encodeURIComponent('2026-11-16T13:20:00.000Z')}`)).json()) as Body;
    expect(body.events).toEqual([]);
    expect(body.since).toBe('2026-11-16T13:20:00.000Z');
  });

  it('#354/AC-2 sem eventos e sem since, o cursor é nulo', async () => {
    const body = (await (await call(new FakePostgrest({}))).json()) as Body;
    expect(body).toMatchObject({ events: [], since: null });
  });

  it.each([
    'ontem',
    '2026-11-16',
    '2026-13-45T10:00:00Z',
    '2026-04-31T10:00:00Z',
    '2026-02-30T10:00:00Z',
    '2026-11-22T25:00:00Z',
    '2026-11-22T10:60:00Z',
    '2026-11-22T10:00:60Z',
    '2026-11-22T10:00:00+24:00',
    '',
    // #354 Só o formato do cursor que a rota devolve: fuso zero (Z ou +00:00), segundos presentes, ano real.
    '2026-11-22T10:00:00+16:00',
    '2026-11-22T10:00:00-23:59',
    '2026-11-22T10:00:00+03:00',
    '2026-11-22T10:00:00+00:30',
    '0000-01-01T00:00:00Z',
    '0000-01-01T00:00:00+00:00',
    '2026-11-22T10:00Z',
    '2026-11-22T10:00+00:00',
    '2026-11-22',
  ])('#354/AC-2 since inválido (%j) responde 400 since_invalido', async (since) => {
    const res = await call(new FakePostgrest(world()), `/api/live?since=${encodeURIComponent(since)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'since_invalido' });
  });

  it.each(['2026-11-16T13:20:00.123456Z', '2026-11-16T13:20:00.123456+00:00', '2026-11-16T13:20:00Z', '2026-11-16T13:20:00.5+00:00'])(
    '#354/AC-2 since com o formato do cursor (%j) passa e volta sem mudar',
    async (since) => {
      const res = await call(new FakePostgrest(world()), `/api/live?since=${encodeURIComponent(since)}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as Body).since).toBe(since);
    },
  );
});

/** #354 O banco guarda microssegundos; o cursor devolvido é o texto do próprio banco, sem arredondar. */
const micro = (minute: number, us = 0) => `2026-11-16T${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.${String(us).padStart(6, '0')}+00:00`;

describe('#354/AC-2 com mais de 50 passos depois de since, a tela não perde nenhum', () => {
  it('#354/AC-2 120 rodadas depois do cursor saem em três consultas seguidas, todas, sem repetir e sem buraco', async () => {
    const runs = Array.from({ length: 120 }, (_, i) => run(i + 1, micro(i + 1)));
    const fake = new FakePostgrest({ automation_runs: runs });
    const seen: string[] = [];
    let since = micro(0);
    for (let poll = 0; poll < 3; poll += 1) {
      const body = (await (await call(fake, `/api/live?since=${encodeURIComponent(since)}`)).json()) as Body;
      expect(body.events.length).toBeLessThanOrEqual(50);
      expect(body.events.map((e) => String(e.at))).toEqual([...body.events.map((e) => String(e.at))].sort().reverse());
      seen.push(...body.events.map((e) => String(e.at)));
      since = body.since ?? since;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(120);
    expect(seen.sort()).toEqual(runs.map((r) => new Date(r.started_at).toISOString()).sort());
    const last = (await (await call(fake, `/api/live?since=${encodeURIComponent(since)}`)).json()) as Body;
    expect(last.events).toEqual([]);
  });

  it('#354/AC-2 o atraso mistura as três fontes: nenhum passo se perde entre as consultas', async () => {
    const runs = Array.from({ length: 60 }, (_, i) => run(i + 1, micro(2 * (i + 1))));
    const decisions = Array.from({ length: 60 }, (_, i) => decision(KEY_A, micro(2 * (i + 1) + 1), { decided_by: 'rule', mode: 'delegated' }));
    const fake = new FakePostgrest({ automation_runs: runs, engine_decisions: decisions, invoices: [{ access_key: KEY_A, number: '101', captured_at: 'x' }] });
    const seen: string[] = [];
    let since = micro(0);
    for (let poll = 0; poll < 6; poll += 1) {
      const body = (await (await call(fake, `/api/live?since=${encodeURIComponent(since)}`)).json()) as Body;
      seen.push(...body.events.map((e) => String(e.at)));
      since = body.since ?? since;
    }
    expect(new Set(seen).size).toBe(120);
  });

  it('#354/AC-2 na borda: o passo do mesmo milissegundo do cursor mas de microssegundo maior ainda sai, e o do cursor não repete', async () => {
    const fake = new FakePostgrest({ automation_runs: [run(1, micro(1, 100)), run(2, micro(1, 300))] });
    const first = (await (await call(fake, `/api/live?since=${encodeURIComponent(micro(0))}`)).json()) as Body;
    expect(first.events).toHaveLength(2);
    expect(first.since).toBe(micro(1, 300));
    const afterFirst = (await (await call(fake, `/api/live?since=${encodeURIComponent(micro(1, 100))}`)).json()) as Body;
    expect(afterFirst.events).toHaveLength(1);
    const repeated = (await (await call(fake, `/api/live?since=${encodeURIComponent(first.since ?? '')}`)).json()) as Body;
    expect(repeated.events).toEqual([]);
    expect(repeated.since).toBe(micro(1, 300));
  });

  it('#354/AC-2 sem since, a tela recebe os 50 mais novos, e o cursor é o texto do banco', async () => {
    const runs = Array.from({ length: 60 }, (_, i) => run(i + 1, micro(i + 1, 7)));
    const body = (await (await call(new FakePostgrest({ automation_runs: runs }))).json()) as Body;
    expect(body.events).toHaveLength(50);
    expect(body.since).toBe(micro(60, 7));
  });
});

describe('#354/AC-3 os indicadores são os de /api/automacao', () => {
  it('#354/AC-3 Dados os mesmos registros, indicators.day é igual nas duas rotas', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T15:00:00Z'));
    const fake = new FakePostgrest(world());
    const live = (await (await call(fake)).json()) as Body;
    const automation = (await (await call(fake, '/api/automacao')).json()) as Body;
    expect(live.indicators.day).toEqual(automation.indicators.day);
    expect(live.indicators.month).toEqual(automation.indicators.month);
    expect(live.indicators.day).toMatchObject({ decided: 3, byRule: 1, byEngine: 1, withoutPersonPct: 67 });
  });

  it('#354/AC-3 awaiting é o total que a fila de aprovação dá', async () => {
    const fake = new FakePostgrest(kitTables());
    const rest = new SupabaseRest({ url: ENV.BARTE_ACADEMY_SUPABASE_URL, secretKey: ENV.BARTE_ACADEMY_SUPABASE_SECRET_KEY, fetch: fake.fetch });
    const { captureDeps } = supabaseConnectors(rest);
    await captureInvoices(captureDeps);
    await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, wms: captureDeps.wms });
    vi.stubGlobal('fetch', fake.fetch);
    const worker = createWorker({ verifier, approval: { store: new SupabaseApprovalStore(rest) } });
    const get = async (path: string) =>
      worker.fetch(new Request(`https://worker.test${path}`, { headers: { 'Cf-Access-Jwt-Assertion': 'ana@jachegou.test' } }), env, ctx);
    const queue = (await (await get('/api/fila?limite=25')).json()) as { total: number };
    const live = (await (await get('/api/live')).json()) as Body;
    expect(queue.total).toBeGreaterThan(0);
    expect(live.awaiting).toBe(queue.total);
  });
});

describe('#354/AC-4 sem credenciais 503, Supabase fora 502, sem Access 401', () => {
  it('#354/AC-4 sem o Access, 401', async () => {
    expect((await call(new FakePostgrest({}), '/api/live', null)).status).toBe(401);
  });

  it('#354/AC-4 sem as credenciais do Supabase, 503 supabase_nao_configurado', async () => {
    const res = await call(new FakePostgrest({}), '/api/live', 'ana@jachegou.test', { ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'supabase_nao_configurado' });
  });

  it('#354/AC-4 com o Supabase fora, 502 supabase_indisponivel, e o log diz só a operação, a tabela e o status', async () => {
    const secret = 'segredo-do-corpo';
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(`{"message":"${secret}"}`, { status: 500 })));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await createWorker({ verifier }).fetch(
      new Request('https://worker.test/api/live', { headers: { 'Cf-Access-Jwt-Assertion': 'ana@jachegou.test' } }), env, ctx);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'supabase_indisponivel' });
    expect(text).not.toContain(secret);
    expect(log).toHaveBeenCalledTimes(1);
    const logged = String(log.mock.calls[0]?.join(' '));
    expect(logged).toMatch(/live: select em \w+ falhou \(HTTP 500\)/);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(ENV.BARTE_ACADEMY_SUPABASE_SECRET_KEY);
  });
});

describe('#354 contrato: as chaves que a tela lê, escritas à mão', () => {
  const keys = (o: object) => Object.keys(o).sort();

  it('#354/AC-1 a resposta tem since, events, indicators e awaiting, e cada kind tem as suas chaves', async () => {
    const body = (await (await call(new FakePostgrest(world()))).json()) as Body;
    expect(keys(body)).toEqual(['awaiting', 'events', 'indicators', 'since']);
    expect(keys(body.indicators)).toEqual(['day', 'month']);
    const of = (kind: string) => body.events.find((e) => e.kind === kind) as Record<string, unknown>;
    expect(keys(of('run'))).toEqual(['actor', 'actor_name', 'at', 'invoice', 'kind', 'status', 'step']);
    expect(keys(of('decision'))).toEqual(['actor', 'actor_name', 'at', 'invoice', 'kind', 'mode', 'step']);
    expect(keys(of('human_decision'))).toEqual(['actor', 'actor_name', 'at', 'invoice', 'kind', 'step']);
    expect(of('run').invoice).toBeNull();
    expect(keys(of('decision').invoice as object)).toEqual(['access_key', 'number']);
    expect(of('decision').invoice).toEqual({ access_key: KEY_B, number: '102' });
  });
});
