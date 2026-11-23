/**
 * #38 O agente do dossiê disparado pelo evento: a proposta que acabou de virar `aguardando_aprovacao` ganha o
 * dossiê sozinha, sem rodada agendada (AC-1). Os testes chamam `generateOnEvent` direto, como o `tick` chama
 * pelo `defer` (cron/tick.ts) — sem laço de tarefas, sem `pending()` relendo o estado da tabela.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClaudeError, type AskWithUsage, type Usage } from '../../src/claude/client.js';
import { restDb } from '../../src/claude/db.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { generateOnEvent } from '../../src/dossier/event.js';
import { readDossier } from '../../src/dossier/read-dossier.js';
import { SupabaseDossierSource } from '../../src/dossier/source.js';
import { busyKeys } from '../../src/dossier/event.js';
import { SupabaseDossierRequests, type DossierRequests } from '../../src/dossier/requests.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { KIT_ACCESS_KEY, kitCase, kitGoodRaw } from './kit-case.js';

const answering = (output: unknown, usage: Usage | null = null) =>
  vi.fn(async () => ({ value: output, usage })) as unknown as AskWithUsage & ReturnType<typeof vi.fn>;

async function setup(suggestions: Record<string, unknown>[] = []) {
  const { invoice, ctx, tables } = await kitCase();
  const fake = new FakePostgrest({ ...tables, claude_suggestions: suggestions, dossier_requests: [] });
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const db = restDb(rest);
  const context = vi.fn(async () => ctx);
  const gaveta = () =>
    readDossier({
      invoiceAccessKey: KIT_ACCESS_KEY,
      invoice,
      loadContext: async () => ctx,
      source: new SupabaseDossierSource(rest),
    });
  const requests = new SupabaseDossierRequests(rest);
  const run = (askWithUsage: AskWithUsage) => generateOnEvent({ db, askWithUsage, context, requests }, invoice);
  return { invoice, ctx, fake, db, context, run, gaveta, requests };
}

const sugestoes = (fake: FakePostgrest) => fake.tables.get('claude_suggestions') ?? [];

describe('#38 do evento à gaveta, sem rodada agendada', () => {
  it('AC-1 a proposta registrada ganha o dossiê na hora, e a gaveta mostra pronto', async () => {
    const { run, gaveta, fake, context } = await setup();
    const ask = answering(kitGoodRaw());
    await run(ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(context).toHaveBeenCalledTimes(1);
    const rows = sugestoes(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task: 'dossier', input_key: KIT_ACCESS_KEY, status: 'ok', trigger: 'event' });
    expect((await gaveta())?.status).toBe('ready');
  });

  it('AC-6 um segundo disparo para a mesma nota não chama o Claude nem relê o contexto', async () => {
    const { run, fake, context } = await setup();
    await run(answering(kitGoodRaw()));
    const again = answering(kitGoodRaw());
    await run(again);
    expect(again).not.toHaveBeenCalled();
    expect(context).toHaveBeenCalledTimes(1);
    expect(sugestoes(fake)).toHaveLength(1);
  });

  it('AC-6 já existe uma linha (de um pedido na gaveta, #130): o evento não dispara', async () => {
    const existing = [
      {
        task: 'dossier',
        input_key: KIT_ACCESS_KEY,
        input: {},
        output: null,
        status: 'generating',
        error: null,
        attempts: 0,
        model: 'claude-haiku',
        updated_at: new Date().toISOString(),
        trigger: 'on_demand',
      },
    ];
    const { run, fake, context } = await setup(existing);
    await run(answering(kitGoodRaw()));
    expect(sugestoes(fake)).toHaveLength(1);
    expect(sugestoes(fake)[0]).toMatchObject({ trigger: 'on_demand', status: 'generating' });
    expect(context).not.toHaveBeenCalled();
  });

  it('AC-3 um número escrito fora de um marcador deixa o dossiê indisponível na gaveta', async () => {
    const { run, gaveta } = await setup();
    await run(answering({ ...kitGoodRaw(), summary: 'A nota cobra 88 UN do leite.' }));
    expect(await gaveta()).toMatchObject({ status: 'unavailable', reason: 'number_mismatch' });
  });

  it('AC-5 a falha do Claude grava o erro, e a gaveta mostra o dossiê indisponível', async () => {
    const { run, gaveta, fake } = await setup();
    await run(vi.fn(async () => { throw new Error('caiu'); }) as unknown as AskWithUsage);
    expect(sugestoes(fake)[0]).toMatchObject({ status: 'error', output: null, trigger: 'event', reason: 'claude_failed' });
    expect(await gaveta()).toMatchObject({ status: 'unavailable', reason: 'claude_failed' });
  });

  it('AC-5 o prazo vencido vira o motivo timeout', async () => {
    const { run, fake } = await setup();
    await run(vi.fn(async () => { throw new ClaudeError('timeout', 'sem resposta'); }) as unknown as AskWithUsage);
    expect(sugestoes(fake)[0]).toMatchObject({ status: 'error', trigger: 'event', reason: 'timeout' });
  });

  it('AC-2 a resposta fora do formato grava o erro de formato, não um erro inesperado', async () => {
    const { run, fake } = await setup();
    await run(answering({ summary: 'x' }));
    const [row] = sugestoes(fake);
    expect(row).toMatchObject({ status: 'error', output: null, attempts: 1, reason: 'invalid_shape' });
    expect(String(row?.error)).toMatch(/^ClaudeError:/);
  });

  it('sem credencial (sem `ask`) não grava linha e não lança: a próxima rodada tenta de novo (auth é global)', async () => {
    const { fake, db, context, invoice, requests } = await setup();
    await expect(generateOnEvent({ db, askWithUsage: undefined, context, requests }, invoice)).resolves.toBe('no_credentials');
    expect(sugestoes(fake)).toHaveLength(0);
  });

  it('limite de uso (429) não grava linha: a próxima rodada tenta de novo, como o laço (ClaudeError.isGlobal)', async () => {
    const { run, fake, gaveta } = await setup();
    await run(vi.fn(async () => { throw new ClaudeError('rate_limit', 'HTTP 429'); }) as unknown as AskWithUsage);
    expect(sugestoes(fake)).toHaveLength(0);
    expect(await gaveta()).toBeNull();
    await run(answering(kitGoodRaw()));
    expect(sugestoes(fake)[0]).toMatchObject({ status: 'ok' });
  });

  it('credencial recusada (401) também não grava linha', async () => {
    const { run, fake } = await setup();
    await run(vi.fn(async () => { throw new ClaudeError('auth', 'HTTP 401'); }) as unknown as AskWithUsage);
    expect(sugestoes(fake)).toHaveLength(0);
  });

  it('a linha de erro é refeita (merge) na retentativa, e volta a ok sem contar tentativa', async () => {
    const erro = [
      {
        task: 'dossier',
        input_key: KIT_ACCESS_KEY,
        input: {},
        output: null,
        status: 'error',
        error: 'ClaudeError: claude: HTTP 500',
        attempts: 1,
        model: 'claude-haiku',
        updated_at: '2026-01-01T00:00:00.000Z',
        trigger: 'event',
      },
    ];
    const { run, fake } = await setup(erro);
    const ask = answering(kitGoodRaw());
    await run(ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(sugestoes(fake)).toHaveLength(1);
    expect(sugestoes(fake)[0]).toMatchObject({ status: 'ok', attempts: 0 });
  });

  it('erro esgotado (3 tentativas) não é tentado de novo', async () => {
    const esgotada = [{ task: 'dossier', input_key: KIT_ACCESS_KEY, input: {}, output: null, status: 'error', error: 'x', attempts: 3, model: 'claude-haiku', updated_at: '2026-01-01T00:00:00.000Z' }];
    const { run } = await setup(esgotada);
    const ask = answering(kitGoodRaw());
    await run(ask);
    expect(ask).not.toHaveBeenCalled();
  });

  it('erro ainda dentro da espera do backoff não é tentado de novo', async () => {
    const agora = new Date().toISOString();
    const naEspera = [{ task: 'dossier', input_key: KIT_ACCESS_KEY, input: {}, output: null, status: 'error', error: 'x', attempts: 1, model: 'claude-haiku', updated_at: agora }];
    const { run } = await setup(naEspera);
    const ask = answering(kitGoodRaw());
    await run(ask);
    expect(ask).not.toHaveBeenCalled();
  });

  it('nota com pedido da gaveta em andamento (busy) não é chamada pelo evento', async () => {
    const { invoice, db, context, requests } = await setup();
    const ask = answering(kitGoodRaw());
    await generateOnEvent({ db, askWithUsage: ask, context, requests, busy: new Set([KIT_ACCESS_KEY]) }, invoice);
    expect(ask).not.toHaveBeenCalled();
  });

  it('AC-4 o dossiê não toca na proposta', async () => {
    const { run, fake } = await setup();
    const before = JSON.stringify(fake.tables.get('proposals') ?? []);
    await run(answering(kitGoodRaw()));
    expect(JSON.stringify(fake.tables.get('proposals') ?? [])).toBe(before);
  });

  it('nunca lança para fora, mesmo se a escrita final falhar', async () => {
    const { ctx, invoice } = await kitCase();
    const db = {
      select: vi.fn(async () => []),
      upsert: vi.fn(async () => { throw new Error('banco fora do ar'); }),
    };
    const requests = {
      open: vi.fn(async () => 1),
      finish: vi.fn(async () => {}),
      claim: vi.fn(async () => true),
      since: vi.fn(async () => []),
      window: vi.fn(async () => []),
      closePending: vi.fn(async () => {}),
      recordFailures: vi.fn(async () => {}),
    } satisfies DossierRequests;
    await expect(
      generateOnEvent({ db, askWithUsage: answering(kitGoodRaw()), context: async () => ctx, requests }, invoice),
    ).resolves.toBeUndefined();
    // O pedido aberto fecha mesmo com a escrita final falhando.
    expect(requests.finish).toHaveBeenCalledWith(1, expect.any(Date), { status: 'error', reason: 'storage_failed' });
  });
});

describe('#38 o uso de tokens gravado na linha do dossiê do evento', () => {
  it('ok: grava input_tokens e output_tokens da resposta', async () => {
    const { run, fake } = await setup();
    await run(answering(kitGoodRaw(), { input_tokens: 1200, output_tokens: 340 }));
    expect(sugestoes(fake)[0]).toMatchObject({ status: 'ok', trigger: 'event', usage: { input_tokens: 1200, output_tokens: 340 } });
  });

  it('resposta fora do formato: grava o erro e o uso já gasto', async () => {
    const { run, fake } = await setup();
    await run(answering({ summary: 'x' }, { input_tokens: 900, output_tokens: 15 }));
    expect(sugestoes(fake)[0]).toMatchObject({ status: 'error', reason: 'invalid_shape', usage: { input_tokens: 900, output_tokens: 15 } });
  });

  it('falha do cliente depois de alguma resposta (o erro traz o uso): grava esse uso', async () => {
    const { run, fake } = await setup();
    const error = new ClaudeError('format', 'sem resposta final em 6 voltas');
    error.usage = { input_tokens: 3000, output_tokens: 200 };
    await run(vi.fn(async () => { throw error; }) as unknown as AskWithUsage);
    expect(sugestoes(fake)[0]).toMatchObject({ status: 'error', usage: { input_tokens: 3000, output_tokens: 200 } });
  });

  it('falha antes de qualquer resposta (prazo): usage nulo', async () => {
    const { run, fake } = await setup();
    await run(vi.fn(async () => { throw new ClaudeError('timeout', 'sem resposta'); }) as unknown as AskWithUsage);
    const [row] = sugestoes(fake);
    expect(row).toMatchObject({ status: 'error', reason: 'timeout' });
    expect(row?.usage).toBeNull();
  });
});

describe('#130 #38 AC-1 o evento abre o pedido que a gaveta lê como Gerando', () => {
  it('abre a linha com trigger event e requested_by claude antes do Claude, e a fecha no fim', async () => {
    const { invoice, db, context, requests, fake } = await setup();
    let during: unknown[] = [];
    const ask = vi.fn(async () => {
      during = (fake.tables.get('dossier_requests') ?? []).map((r) => ({ ...r }));
      return { value: kitGoodRaw(), usage: null };
    }) as unknown as AskWithUsage;
    await generateOnEvent({ db, askWithUsage: ask, context, requests }, invoice);
    expect(during).toEqual([expect.objectContaining({ input_key: KIT_ACCESS_KEY, requested_by: 'claude', trigger: 'event', finished_at: null })]);
    const after = fake.tables.get('dossier_requests') ?? [];
    expect(after).toHaveLength(1);
    expect(after[0]?.finished_at).not.toBeNull();
  });

  it('fecha o pedido mesmo quando o Claude falha', async () => {
    const { invoice, db, context, requests, fake } = await setup();
    const ask = vi.fn(async () => {
      throw new ClaudeError('timeout', 'prazo');
    }) as unknown as AskWithUsage;
    await generateOnEvent({ db, askWithUsage: ask, context, requests, log: () => {} }, invoice);
    expect((fake.tables.get('dossier_requests') ?? [])[0]?.finished_at).not.toBeNull();
  });

  it('#130 nota com pedido da gaveta aberto entra em busyKeys e o evento não abre outro pedido', async () => {
    const { invoice, db, context, requests, fake } = await setup();
    const now = new Date();
    await requests.open({ input_key: KIT_ACCESS_KEY, requested_by: 'ana@exemplo.com', requested_at: now.toISOString(), trigger: 'on_demand' });
    const busy = await busyKeys(requests, now);
    expect(busy.has(KIT_ACCESS_KEY)).toBe(true);
    const ask = answering(kitGoodRaw());
    await generateOnEvent({ db, askWithUsage: ask, context, requests, busy }, invoice);
    expect(ask).not.toHaveBeenCalled();
    expect(fake.tables.get('dossier_requests')).toHaveLength(1);
  });
});

describe('#130 o fim fecha só o próprio pedido', () => {
  it('o fim do evento não fecha um pedido da gaveta aberto para a mesma nota', async () => {
    const { invoice, db, context, requests, fake } = await setup();
    const drawerId = await requests.open({ input_key: KIT_ACCESS_KEY, requested_by: 'ana@exemplo.com', requested_at: new Date().toISOString(), trigger: 'on_demand' });
    await generateOnEvent({ db, askWithUsage: answering(kitGoodRaw()), context, requests }, invoice);
    const rows = fake.tables.get('dossier_requests') ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === drawerId)?.finished_at).toBeNull();
    expect(rows.find((r) => r.id !== drawerId)?.finished_at).not.toBeNull();
  });
});

describe('#38 #130 duas propostas no mesmo disparo: cada linha com o próprio uso e o próprio pedido', () => {
  it('cada claude_suggestions guarda o uso da sua resposta, e o evento abre e fecha um pedido por nota', async () => {
    const { invoice, db, context, requests, fake } = await setup();
    // Outra nota, com o resto da NF-004 como está (o protótipo leva itens e divergências).
    const otherKey = `${KIT_ACCESS_KEY.slice(0, -1)}9`;
    const other = Object.assign(Object.create(invoice) as typeof invoice, { accessKey: otherKey });
    const usageOf: Record<string, Usage> = {
      [KIT_ACCESS_KEY]: { input_tokens: 1200, output_tokens: 340 },
      [otherKey]: { input_tokens: 800, output_tokens: 95 },
    };
    const opened: unknown[] = [];
    for (const nota of [invoice, other]) {
      const ask = vi.fn(async () => {
        opened.push(...(fake.tables.get('dossier_requests') ?? []).filter((r) => r.input_key === nota.accessKey).map((r) => ({ ...r })));
        return { value: kitGoodRaw(), usage: usageOf[nota.accessKey] };
      }) as unknown as AskWithUsage;
      await generateOnEvent({ db, askWithUsage: ask, context, requests }, nota);
    }
    const rows = sugestoes(fake);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.input_key === KIT_ACCESS_KEY)).toMatchObject({ status: 'ok', trigger: 'event', usage: usageOf[KIT_ACCESS_KEY] });
    expect(rows.find((r) => r.input_key === otherKey)).toMatchObject({ status: 'ok', trigger: 'event', usage: usageOf[otherKey] });
    // Durante cada chamada, o pedido do evento da própria nota estava aberto.
    expect(opened).toEqual([
      expect.objectContaining({ input_key: KIT_ACCESS_KEY, requested_by: 'claude', trigger: 'event', finished_at: null }),
      expect.objectContaining({ input_key: otherKey, requested_by: 'claude', trigger: 'event', finished_at: null }),
    ]);
    const reqs = fake.tables.get('dossier_requests') ?? [];
    expect(reqs).toHaveLength(2);
    expect(reqs.every((r) => r.finished_at !== null)).toBe(true);
  });
});

describe('#311 o pedido do evento fecha com o status e o motivo, no mesmo PATCH', () => {
  const requestsOf = (fake: FakePostgrest) => fake.tables.get('dossier_requests') ?? [];
  // #311 dublê: só o contrato usado (a pergunta ao Claude), não o AskWithUsage inteiro.
  const failing = (error: Error) => vi.fn(async () => { throw error; }) as unknown as AskWithUsage;

  it('#311/AC-2 dossiê gravado: o pedido fecha em done, sem motivo', async () => {
    const { run, fake } = await setup();
    await run(answering(kitGoodRaw()));
    expect(requestsOf(fake)[0]).toMatchObject({ status: 'done', reason: null, finished_at: expect.any(String) });
  });

  it.each([
    ['429', new ClaudeError('rate_limit', 'HTTP 429'), 'rate_limited'],
    ['401', new ClaudeError('auth', 'HTTP 401'), 'auth_refused'],
  ])('#311/AC-3 erro global (%s): o pedido fecha em error com o motivo %s e o motivo volta a quem despacha', async (_name, error, reason) => {
    const { run, fake } = await setup();
    await expect(run(failing(error))).resolves.toBe(reason);
    expect(requestsOf(fake)[0]).toMatchObject({ status: 'error', reason, finished_at: expect.any(String) });
    expect(sugestoes(fake)).toHaveLength(0);
  });

  it('#311/AC-3 sem credencial no Worker: error/no_credentials', async () => {
    const { fake, db, context, invoice, requests } = await setup();
    await expect(generateOnEvent({ db, askWithUsage: undefined, context, requests }, invoice)).resolves.toBe('no_credentials');
    expect(requestsOf(fake)[0]).toMatchObject({ status: 'error', reason: 'no_credentials' });
  });

  it('#311/AC-3 erro que não é global (timeout): o pedido fecha em error/claude_failed e o lote segue (nada volta)', async () => {
    const { run, fake } = await setup();
    await expect(run(failing(new ClaudeError('timeout', 'sem resposta')))).resolves.toBeUndefined();
    expect(requestsOf(fake)[0]).toMatchObject({ status: 'error', reason: 'claude_failed' });
    expect(sugestoes(fake)[0]).toMatchObject({ status: 'error', reason: 'timeout' });
  });
});

describe('#311/AC-4 o pedido pending é reivindicado pelo disparo, no lugar do open', () => {
  const pendingRow = (id: number) => ({ id, input_key: KIT_ACCESS_KEY, requested_by: 'backfill', requested_at: '2026-11-22T10:00:00.000Z', finished_at: null, trigger: 'event', status: 'pending', reason: null });

  it('reivindica (running, requested_at agora), gera o dossiê e fecha o mesmo pedido em done, sem abrir outro', async () => {
    const { invoice, db, context, requests, fake } = await setup();
    fake.tables.set('dossier_requests', [pendingRow(41)]);
    let during: unknown;
    // #311 dublê: só o contrato usado (a pergunta ao Claude), não o AskWithUsage inteiro.
    const ask = vi.fn(async () => {
      during = { ...(fake.tables.get('dossier_requests') ?? [])[0] };
      return { value: kitGoodRaw(), usage: null };
    }) as unknown as AskWithUsage; // #311 dublê: só o contrato usado (a pergunta ao Claude), não o AskWithUsage inteiro.
    const now = new Date('2026-11-22T12:00:00.000Z');
    await generateOnEvent({ db, askWithUsage: ask, context, requests, now: () => now }, invoice, 41);
    expect(during).toMatchObject({ id: 41, status: 'running', requested_at: now.toISOString(), finished_at: null });
    const rows = fake.tables.get('dossier_requests') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 41, status: 'done', finished_at: now.toISOString() });
  });

  it('já reivindicado por outra invocação (não está mais pending): não chama o Claude', async () => {
    const { invoice, db, context, requests, fake } = await setup();
    fake.tables.set('dossier_requests', [{ ...pendingRow(41), status: 'running' }]);
    const ask = answering(kitGoodRaw());
    await generateOnEvent({ db, askWithUsage: ask, context, requests }, invoice, 41);
    expect(ask).not.toHaveBeenCalled();
  });

  it('busyKeys: o pending não é geração em andamento, o running recente é', async () => {
    const { requests, fake } = await setup();
    const now = new Date('2026-11-22T12:00:00.000Z');
    fake.tables.set('dossier_requests', [
      { ...pendingRow(1), input_key: 'a', requested_at: '2026-11-22T11:59:00.000Z' },
      { ...pendingRow(2), input_key: 'b', requested_at: '2026-11-22T11:59:00.000Z', status: 'running' },
    ]);
    const busy = await busyKeys(requests, now);
    expect([...busy]).toEqual(['b']);
  });
});
