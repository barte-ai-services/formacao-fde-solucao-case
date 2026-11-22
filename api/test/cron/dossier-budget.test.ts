// #311 A conta de subrequests da invocação do dossiê (cron 11-59/15), medida de verdade com a fila cheia, no estilo de claude/budget.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOSSIER_EVENT_LIMIT } from '../../src/cron/dossier-round.js';
import { awaitingKeys, kitAwaitingPeople, runDossierCron, WITH_CLAUDE } from '../support/dossier-world.js';
import { SUBREQUEST_CAP } from '../support/subrequest-counter.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * #311 A conta: leituras (os pedidos da janela 1, as sugestões 1, as propostas que esperam 6) + o contexto do dossiê 13 (medido: o
 * comentário de antes dizia 7, e eram 13 leituras dos conectores) + por disparo 5 (a linha anterior, a reivindicação ou o open,
 * o Claude, o upsert, o fim) = 8 + 13 + 25 = 46 com DOSSIER_EVENT_LIMIT = 5. Fechar pendentes que perderam o sentido custa até 2 PATCH: 48.
 */
const READS = 8;
const CONTEXT_READS = 13;
const PER_DISPATCH = 5;
const COUNTED = READS + CONTEXT_READS + DOSSIER_EVENT_LIMIT * PER_DISPATCH;
const SETTLE_PATCHES = 2;

describe('#311 o dossiê cabe nos 50 subrequests da própria invocação', () => {
  it('#311/AC-2: com a fila cheia (mais propostas que o teto), a invocação gasta o que está contado e fica abaixo de 50', async () => {
    const fake = await kitAwaitingPeople();
    expect(awaitingKeys(fake).length).toBeGreaterThan(DOSSIER_EVENT_LIMIT);

    const run = await runDossierCron(fake, WITH_CLAUDE, { cap: SUBREQUEST_CAP });

    expect(run.claudeCalls()).toBe(DOSSIER_EVENT_LIMIT);
    expect(run.counter.count()).toBe(COUNTED);
    expect(COUNTED).toBeLessThan(SUBREQUEST_CAP);
  });

  it('#311/AC-4: com pendentes do backfill no lote, a invocação ainda cabe (a reivindicação ocupa o lugar do open)', async () => {
    const fake = await kitAwaitingPeople();
    const keys = awaitingKeys(fake).slice(-DOSSIER_EVENT_LIMIT);
    fake.tables.set(
      'dossier_requests',
      keys.map((input_key, i) => ({ id: 9001 + i, input_key, requested_by: 'backfill', requested_at: '2026-11-22T10:00:00.000Z', finished_at: null, trigger: 'event', status: 'pending', reason: null })),
    );

    const run = await runDossierCron(fake, WITH_CLAUDE, { cap: SUBREQUEST_CAP });

    expect(run.counter.count()).toBe(COUNTED);
    expect(fake.rows('dossier_requests').every((r) => r.status === 'done')).toBe(true);
  });

  it('#311/AC-4: no pior caso, com 5 pendentes no lote e dois pendentes a fechar (dossiê já ok e proposta que não espera mais), gasta 48 e cabe', async () => {
    const fake = await kitAwaitingPeople();
    const keys = awaitingKeys(fake);
    const batch = keys.slice(-DOSSIER_EVENT_LIMIT);
    const [ready] = keys;
    const pending = (id: number, input_key: string) => ({ id, input_key, requested_by: 'backfill', requested_at: '2026-11-22T10:00:00.000Z', finished_at: null, trigger: 'event', status: 'pending', reason: null });
    fake.tables.set('claude_suggestions', [{ task: 'dossier', input_key: ready, input: {}, output: {}, status: 'ok', error: null, attempts: 0, model: 'm', updated_at: '2026-11-22T09:00:00.000Z', trigger: 'on_demand' }]);
    fake.tables.set('dossier_requests', [...batch.map((k, i) => pending(9001 + i, k)), pending(9100, ready as string), pending(9101, 'nota-que-nao-espera-mais')]);

    const run = await runDossierCron(fake, WITH_CLAUDE, { cap: SUBREQUEST_CAP });

    expect(run.counter.count()).toBe(COUNTED + SETTLE_PATCHES);
    expect(COUNTED + SETTLE_PATCHES).toBeLessThanOrEqual(SUBREQUEST_CAP);
    expect(fake.rows('dossier_requests').find((r) => r.id === 9101)).toMatchObject({ status: 'done', reason: 'not_needed' });
    expect(fake.rows('dossier_requests').every((r) => r.status === 'done')).toBe(true);
  });
});
