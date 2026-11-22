/**
 * #311 O dossiê gerado sozinho em produção. A causa (AC-1) por código: o tick de 15 minutos gasta o teto de 50 subrequests
 * antes de chegar ao dossiê, e o disparo falhava calado. Aqui o comportamento que a correção entrega: o cron próprio do
 * dossiê gera, dentro do teto, deixa rastro quando falha e dá conta das propostas que já existiam.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTEMPTS } from '../../src/claude/runner.js';
import { dispatchDossiers, DOSSIER_EVENT_LIMIT } from '../../src/cron/dossier-round.js';
import { CLAUDE_CRON, DOSSIER_CRON, dispatchScheduled } from '../../src/cron/schedule.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { countSubrequests } from '../support/subrequest-counter.js';
import { awaitingKeys, eventSuggestions, kitAwaitingPeople, runDossierCron, SUPABASE_ENV, WITH_CLAUDE } from '../support/dossier-world.js';
import { SUBREQUEST_CAP } from '../support/subrequest-counter.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#311 a causa: o tick de 15 minutos já gasta o teto antes do dossiê', () => {
  it('#311/AC-1: a captura, a proposta e as publicações do tick, sozinhas, passam de 50 subrequests; por isso o dossiê tem a própria invocação', async () => {
    const fake = new FakePostgrest(kitTables());
    const counter = countSubrequests(fake.fetch, 10_000);
    vi.stubGlobal('fetch', counter.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await dispatchScheduled({ cron: CLAUDE_CRON }, WITH_CLAUDE);

    // #311 Medido em 22/11 sobre o kit inteiro: 172 subrequests no tick sem o dossiê (141 até o ponto onde o dossiê rodava). O teto é 50.
    expect(counter.count()).toBeGreaterThan(SUBREQUEST_CAP);
    expect(counter.trail().some((t) => t.includes('dossier_requests'))).toBe(false);
  });
});

describe('#311 a proposta nova ganha dossiê sozinha, dentro do teto de subrequests', () => {
  it('#311/AC-2: com a credencial do Claude, o cron do dossiê grava linhas event ok e fecha os pedidos em done, sem passar de 50 subrequests', async () => {
    const fake = await kitAwaitingPeople();
    expect(awaitingKeys(fake).length).toBeGreaterThan(DOSSIER_EVENT_LIMIT);

    const run = await runDossierCron(fake, WITH_CLAUDE, { cap: SUBREQUEST_CAP });

    expect(eventSuggestions(fake)).toHaveLength(DOSSIER_EVENT_LIMIT);
    expect(eventSuggestions(fake).every((r) => r.status === 'ok')).toBe(true);
    const requests = fake.rows('dossier_requests').filter((r) => r.trigger === 'event');
    expect(requests).toHaveLength(DOSSIER_EVENT_LIMIT);
    expect(requests.every((r) => r.status === 'done' && r.finished_at !== null)).toBe(true);
    expect(run.counter.count()).toBeLessThanOrEqual(SUBREQUEST_CAP);
  });
});

describe('#311 a falha do caminho automático deixa rastro e respeita o backoff', () => {
  const errorRequests = (fake: Awaited<ReturnType<typeof kitAwaitingPeople>>) => fake.rows('dossier_requests').filter((r) => r.status === 'error');

  it('#311/AC-3: o limite de uso (429) fecha o pedido em error com o motivo rate_limited e para o lote no primeiro erro', async () => {
    const fake = await kitAwaitingPeople();
    const run = await runDossierCron(fake, WITH_CLAUDE, { claude: () => new Response('{}', { status: 429 }) });

    expect(run.claudeCalls()).toBe(1);
    expect(errorRequests(fake)).toEqual([expect.objectContaining({ trigger: 'event', reason: 'rate_limited', finished_at: expect.any(String) })]);
    expect(eventSuggestions(fake)).toHaveLength(0);
  });

  it('#311/AC-3: a credencial recusada (401) fecha o pedido em error com o motivo auth_refused, sem o segredo', async () => {
    const fake = await kitAwaitingPeople();
    const run = await runDossierCron(fake, WITH_CLAUDE, { claude: () => new Response('{}', { status: 401 }) });

    expect(run.claudeCalls()).toBe(1);
    expect(errorRequests(fake)).toEqual([expect.objectContaining({ reason: 'auth_refused' })]);
    expect(JSON.stringify(fake.rows('dossier_requests'))).not.toContain('fake-oauth-token');
  });

  it('#311/AC-3: sem credencial do Claude no Worker, uma linha error/no_credentials por chave do lote, fechada, num insert só', async () => {
    const fake = await kitAwaitingPeople();
    const before = fake.requests.length;
    const run = await runDossierCron(fake, SUPABASE_ENV);

    expect(run.claudeCalls()).toBe(0);
    const failed = errorRequests(fake);
    expect(failed).toHaveLength(DOSSIER_EVENT_LIMIT);
    expect(failed.every((r) => r.reason === 'no_credentials' && r.finished_at !== null)).toBe(true);
    const inserts = fake.requests.slice(before).filter((r) => r.method === 'POST' && r.url.includes('/dossier_requests'));
    expect(inserts).toHaveLength(1);
  });

  it('#311/AC-3: dentro do backoff a rodada não chama o Claude nem grava de novo; passado o backoff, tenta outra vez, sem loop', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T12:00:00Z'));
    const fake = await kitAwaitingPeople();
    await runDossierCron(fake, WITH_CLAUDE, { claude: () => new Response('{}', { status: 429 }) });
    expect(errorRequests(fake)).toHaveLength(1);

    vi.setSystemTime(new Date('2026-11-22T12:15:00Z'));
    const inside = await runDossierCron(fake, WITH_CLAUDE);
    expect(inside.claudeCalls()).toBe(0);
    expect(errorRequests(fake)).toHaveLength(1);

    vi.setSystemTime(new Date('2026-11-22T12:31:00Z'));
    const after = await runDossierCron(fake, WITH_CLAUDE);
    expect(after.claudeCalls()).toBe(DOSSIER_EVENT_LIMIT);
    expect(eventSuggestions(fake)).toHaveLength(DOSSIER_EVENT_LIMIT);
  });
});

describe('#311 as propostas que já existiam sem dossiê', () => {
  it('#311/AC-4: o pedido pending não trava a própria geração: o cron o reivindica, gera o dossiê e o fecha em done', async () => {
    const fake = await kitAwaitingPeople();
    const keys = awaitingKeys(fake);
    const last = keys.slice(-2);
    fake.tables.set(
      'dossier_requests',
      last.map((input_key, i) => ({ id: 9001 + i, input_key, requested_by: 'backfill', requested_at: '2026-11-22T10:00:00.000Z', finished_at: null, trigger: 'event', status: 'pending', reason: null })),
    );

    await runDossierCron(fake, WITH_CLAUDE);

    expect(eventSuggestions(fake).map((r) => r.input_key)).toEqual(expect.arrayContaining(last));
    const claimed = fake.rows('dossier_requests').filter((r) => r.requested_by === 'backfill');
    expect(claimed.every((r) => r.status === 'done' && r.finished_at !== null)).toBe(true);
  });

  it('#311/AC-4: o pending cujo dossiê já está ok fecha em done sem chamar o Claude por ele', async () => {
    const fake = await kitAwaitingPeople();
    const [key] = awaitingKeys(fake);
    fake.tables.set('claude_suggestions', [{ task: 'dossier', input_key: key, input: {}, output: {}, status: 'ok', error: null, attempts: 0, model: 'm', updated_at: '2026-11-22T09:00:00.000Z', trigger: 'on_demand' }]);
    fake.tables.set('dossier_requests', [{ id: 9100, input_key: key, requested_by: 'backfill', requested_at: '2026-11-22T10:00:00.000Z', finished_at: null, trigger: 'event', status: 'pending', reason: null }]);

    await runDossierCron(fake, WITH_CLAUDE);

    expect(fake.rows('dossier_requests').find((r) => r.id === 9100)).toMatchObject({ status: 'done', finished_at: expect.any(String) });
    expect(eventSuggestions(fake).map((r) => r.input_key)).not.toContain(key);
  });

  it('#311/AC-4: o pending de chave esgotada (error com MAX_ATTEMPTS tentativas) fecha em error/claude_failed e não fica na janela', async () => {
    const fake = await kitAwaitingPeople();
    const [key] = awaitingKeys(fake);
    fake.tables.set('claude_suggestions', [{ task: 'dossier', input_key: key, input: {}, output: null, status: 'error', error: 'x', attempts: MAX_ATTEMPTS, model: 'm', updated_at: '2026-11-22T09:00:00.000Z', trigger: 'event' }]);
    fake.tables.set('dossier_requests', [{ id: 9200, input_key: key, requested_by: 'backfill', requested_at: '2026-11-22T10:00:00.000Z', finished_at: null, trigger: 'event', status: 'pending', reason: null }]);

    await runDossierCron(fake, WITH_CLAUDE);

    expect(fake.rows('dossier_requests').find((r) => r.id === 9200)).toMatchObject({ status: 'error', reason: 'claude_failed', finished_at: expect.any(String) });
    expect(eventSuggestions(fake).find((r) => r.input_key === key)).toMatchObject({ status: 'error', attempts: MAX_ATTEMPTS });
  });
});

describe('#311 a falha que não é do Supabase aparece no log com a classe', () => {
  it('#311/AC-3: um TypeError na invocação é logado com a classe, sem o texto do erro nem segredo', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    class BrokenRest extends SupabaseRest {
      override select(): Promise<unknown[]> {
        return Promise.reject(new TypeError('segredo-no-texto fake-oauth-token'));
      }
    }
    const rest = new BrokenRest({ url: SUPABASE_ENV.BARTE_ACADEMY_SUPABASE_URL ?? '', secretKey: 'sb_secret_fake' });

    await dispatchDossiers(WITH_CLAUDE, rest, supabaseConnectors(rest).captureDeps);

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('TypeError') && l.includes('falha'))).toBe(true);
    expect(lines.join('\n')).not.toContain('segredo-no-texto');
    expect(lines.join('\n')).not.toContain('fake-oauth-token');
  });
});
