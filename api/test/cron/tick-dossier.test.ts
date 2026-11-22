/**
 * #38 AC-1: o dossiê dispara sozinho, sem rodada agendada do laço de tarefas (#66/#171), que relê o estado da tabela a cada tick.
 * #311 Ele saiu do tick de 15 minutos e roda na própria invocação (o cron do dossiê, cron/dossier-round.ts): os testes de
 * ponta a ponta de antes migraram para ela, sobre a base do kit já capturada e proposta (test/support/dossier-world.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tasksFor } from '../../src/claude/tasks/index.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { DOSSIER_EVENT_LIMIT } from '../../src/cron/dossier-round.js';
import { tick } from '../../src/cron/tick.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { claudeOk, eventSuggestions, kitAwaitingPeople, runDossierCron, SUPABASE_ENV, WITH_CLAUDE } from '../support/dossier-world.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const dossierRows = (fake: FakePostgrest) => fake.rows('claude_suggestions').filter((r) => r.task === 'dossier');

describe('#38 o dossiê não é uma tarefa do laço do Claude', () => {
  it('tasksFor() não registra o dossiê: ele não faz parte da rodada agendada do #66/#171', () => {
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake' });
    expect(tasksFor(rest).map((t) => t.name)).not.toContain('dossier');
  });
});

describe('#38 AC-1: o cron do dossiê gera o dossiê das propostas que esperam uma pessoa', () => {
  it('com a credencial do Claude, a invocação grava dossiês com trigger event, até o teto por invocação', async () => {
    const fake = await kitAwaitingPeople();

    await runDossierCron(fake, WITH_CLAUDE);

    const rows = dossierRows(fake);
    expect(rows.length).toBe(DOSSIER_EVENT_LIMIT);
    expect(rows.every((r) => r.trigger === 'event' && r.status === 'ok')).toBe(true);
  });

  it('#38 a linha do dossiê gravada pela invocação leva o uso de tokens da resposta da Messages API', async () => {
    const fake = await kitAwaitingPeople();
    const withUsage = () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'tool_use', name: 'responder', input: { summary: 'ok', divergences: [], supplier_history: 'ok' } }],
          usage: { input_tokens: 1500, output_tokens: 420 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    await runDossierCron(fake, WITH_CLAUDE, { claude: withUsage });

    const rows = dossierRows(fake);
    expect(rows.length).toBe(DOSSIER_EVENT_LIMIT);
    for (const row of rows) {
      expect(row).toMatchObject({ trigger: 'event', status: 'ok', usage: { input_tokens: 1500, output_tokens: 420 } });
    }
  });

  it('AC-5: sem a credencial do Claude, a invocação não grava nenhum dossiê nem chama o Claude, e deixa o rastro no pedido (#311)', async () => {
    const fake = await kitAwaitingPeople();

    const run = await runDossierCron(fake, SUPABASE_ENV);

    expect(dossierRows(fake)).toHaveLength(0);
    expect(run.claudeCalls()).toBe(0);
    expect(fake.rows('dossier_requests').every((r) => r.reason === 'no_credentials')).toBe(true);
  });

  it('AC-6: a segunda invocação pega o lote seguinte (rede de segurança) e nunca repete uma chave', async () => {
    const fake = await kitAwaitingPeople();

    await runDossierCron(fake, WITH_CLAUDE);
    expect(dossierRows(fake)).toHaveLength(DOSSIER_EVENT_LIMIT);
    await runDossierCron(fake, WITH_CLAUDE);

    // As 5 do primeiro ciclo estão ok e não voltam; a segunda invocação cobre mais 5 das que esperam.
    const keys = dossierRows(fake).map((r) => r.input_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(2 * DOSSIER_EVENT_LIMIT);
  });

  it('AC-5: com o limite de uso (429) na invocação, nenhuma linha de dossiê é gravada e a próxima tenta de novo depois do backoff', async () => {
    const fake = await kitAwaitingPeople();

    await runDossierCron(fake, WITH_CLAUDE, { claude: () => new Response('{}', { status: 429 }) });

    expect(dossierRows(fake)).toHaveLength(0);
    expect(eventSuggestions(fake)).toHaveLength(0);
  });
});

describe('#311 o tick de 15 minutos não carrega mais o dossiê', () => {
  it('#311/AC-2: com a credencial do Claude, o tick não lê dossier_requests nem chama a Messages API pelo dossiê', async () => {
    const fake = new FakePostgrest(kitTables());
    const claudeCalls: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://api.anthropic.com/')) {
        claudeCalls.push(String(input));
        return Promise.resolve(claudeOk());
      }
      return fake.fetch(String(input), init);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await tick({ cron: '*/15 * * * *' }, WITH_CLAUDE);

    expect(fake.requests.some((r) => r.url.includes('/dossier_requests'))).toBe(false);
    expect(dossierRows(fake)).toHaveLength(0);
  });
});
