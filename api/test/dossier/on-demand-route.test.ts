/**
 * #130 O dossiê pedido na gaveta: POST /api/propostas/:chave/dossie. Usa a NF-004 da base do kit, o PostgREST
 * falso e um Claude falso. O waitUntil do teste guarda a geração, e o teste a espera antes de conferir o banco.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryApprovalStore, type CaseFile } from '../../src/approval/store.js';
import { ASK_TIMEOUT_MS, ClaudeError, type AskWithUsage, type FetchFn } from '../../src/claude/client.js';
import { restDb } from '../../src/claude/db.js';
import { needsDossier } from '../../src/claude/tasks/dossier.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { draftProposal, propose } from '../../src/domain/approval.js';
import { ApprovalPolicy } from '../../src/domain/approval-policy.js';
import { Title, type Invoice } from '../../src/domain/index.js';
import { ON_DEMAND_ASK_TIMEOUT_MS, onDemandAskWithUsage } from '../../src/dossier/on-demand.js';
import { SupabaseDossierRequests } from '../../src/dossier/requests.js';
import { SupabaseDossierSource } from '../../src/dossier/source.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { KIT_ACCESS_KEY, kitCase, kitGoodRaw } from './kit-case.js';

const TODAY = '2026-11-15';
const ANALISTA = 'analista@jachegou.test';
const NOW = new Date('2026-11-15T13:00:00.000Z');
const env: Env = {
  ACCESS_AUD: 'aud',
  ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com',
  APPROVER_LEVELS: JSON.stringify({ [ANALISTA]: 'analista' }),
};
const verifier: AccessVerifier = {
  async verify(token) {
    return { ok: true, identity: { email: token } };
  },
};

function caseFile(invoice: Invoice): CaseFile {
  const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: '2026-12-10' });
  const route = ApprovalPolicy.route(invoice);
  const { proposal, approval } = propose(invoice, title, { route, ...draftProposal(invoice, null), today: TODAY });
  return { invoice, proposal, title, route, approval, supplierBlocked: false };
}

const answering = (output: unknown) => vi.fn(async () => ({ value: output, usage: null })) as unknown as AskWithUsage & ReturnType<typeof vi.fn>;

type Setup = { ask?: AskWithUsage; suggestions?: Record<string, unknown>[]; requests?: Record<string, unknown>[]; now?: () => Date };

async function setup(options: Setup = {}) {
  const { invoice, ctx, tables } = await kitCase();
  const file = caseFile(invoice);
  expect(needsDossier(file)).toBe(true);
  const fake = new FakePostgrest({
    ...tables,
    claude_suggestions: options.suggestions ?? [],
    dossier_requests: options.requests ?? [],
  });
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const context = vi.fn(async () => ctx);
  const now = options.now ?? (() => NOW);
  const worker = createWorker({
    verifier,
    approval: {
      store: new MemoryApprovalStore([file]),
      today: () => TODAY,
      dossier: {
        source: new SupabaseDossierSource(rest),
        context,
        requests: new SupabaseDossierRequests(rest),
        onDemand: { db: restDb(rest), askWithUsage: options.ask, secrets: ['sk-segredo'], log: () => {} },
        now,
      },
    },
  });
  const pending: Promise<unknown>[] = [];
  const ctxOf = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, props: {} };
  const call = (path: string, method: string, user: string | null = ANALISTA) =>
    worker.fetch(
      new Request(`https://worker.test${path}`, { method, headers: user ? { 'Cf-Access-Jwt-Assertion': user } : {} }),
      env,
      ctxOf as unknown as ExecutionContext,
    );
  const ask = () => call(`/api/propostas/${KIT_ACCESS_KEY}/dossie`, 'POST');
  const settle = async () => {
    await Promise.all(pending.splice(0));
  };
  const drawer = async () => {
    const res = await call(`/api/propostas/${KIT_ACCESS_KEY}`, 'GET');
    expect(res.status).toBe(200);
    return ((await res.json()) as { dossier: Record<string, unknown> }).dossier;
  };
  return { fake, ask, call, settle, drawer, context };
}

const suggestions = (fake: FakePostgrest) => fake.rows('claude_suggestions');
const requests = (fake: FakePostgrest) => fake.rows('dossier_requests');

/** Uma linha ok do dossiê da NF-004, como o evento (#38) a teria gravado. */
const okRow = () => ({
  task: 'dossier',
  input_key: KIT_ACCESS_KEY,
  input: {},
  output: kitGoodRaw(),
  status: 'ok',
  error: null,
  attempts: 0,
  model: 'claude-haiku',
  updated_at: '2026-11-15T10:15:00.000Z',
  trigger: 'event',
});

describe('#130 POST /api/propostas/:chave/dossie', () => {
  it('AC-2 202 com generating, e a geração em segundo plano grava o dossiê ok com trigger on_demand', async () => {
    const claude = answering(kitGoodRaw());
    const { ask, settle, fake, drawer } = await setup({ ask: claude });
    const res = await ask();
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ status: 'generating', trigger: 'on_demand', requested_by: ANALISTA, requested_at: NOW.toISOString() });
    // AC-7: a resposta não leva segredo nenhum.
    expect(JSON.stringify(body)).not.toContain('sk-segredo');
    await settle();
    expect(claude).toHaveBeenCalledTimes(1);
    expect(suggestions(fake)).toHaveLength(1);
    expect(suggestions(fake)[0]).toMatchObject({
      task: 'dossier',
      input_key: KIT_ACCESS_KEY,
      status: 'ok',
      trigger: 'on_demand',
      requested_by: ANALISTA,
      requested_at: NOW.toISOString(),
      reason: null,
      latency_ms: 0,
    });
    expect(requests(fake)[0]).toMatchObject({ requested_by: ANALISTA, finished_at: NOW.toISOString() });
    expect((await drawer()).status).toBe('ready');
  });

  it('AC-6 sem login no Access, 401, e nada é gravado', async () => {
    const { call, fake } = await setup({ ask: answering(kitGoodRaw()) });
    const res = await call(`/api/propostas/${KIT_ACCESS_KEY}/dossie`, 'POST', null);
    expect(res.status).toBe(401);
    expect(requests(fake)).toHaveLength(0);
  });

  it('AC-6 com uma geração em andamento, 409 em_andamento', async () => {
    const open = { input_key: KIT_ACCESS_KEY, requested_by: 'outra@jachegou.test', requested_at: '2026-11-15T12:58:00.000Z', finished_at: null };
    const claude = answering(kitGoodRaw());
    const { ask, fake } = await setup({ ask: claude, requests: [open] });
    const res = await ask();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'em_andamento' });
    expect(requests(fake)).toHaveLength(1);
    expect(claude).not.toHaveBeenCalled();
  });

  it('#130 um pedido aberto há mais de 5 min é abandonado e não bloqueia', async () => {
    const stale = { input_key: KIT_ACCESS_KEY, requested_by: 'outra@jachegou.test', requested_at: '2026-11-15T12:50:00.000Z', finished_at: null };
    const { ask } = await setup({ ask: answering(kitGoodRaw()), requests: [stale] });
    expect((await ask()).status).toBe(202);
  });

  it('AC-6 o 4º pedido na mesma hora recebe 429 limite', async () => {
    let clock = NOW.getTime();
    const { ask, settle, fake } = await setup({ ask: answering(kitGoodRaw()), now: () => new Date(clock) });
    for (let i = 0; i < 3; i += 1) {
      expect((await ask()).status).toBe(202);
      await settle();
      clock += 60_000;
    }
    const res = await ask();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'limite' });
    expect(requests(fake)).toHaveLength(3);
    // Passada a hora do primeiro, o pedido volta a ser aceito.
    clock = NOW.getTime() + 61 * 60_000;
    expect((await ask()).status).toBe(202);
  });

  it('#130 chave desconhecida dá 404, e chave fora do formato dá 400', async () => {
    const { call } = await setup({ ask: answering(kitGoodRaw()) });
    expect((await call('/api/propostas/35999999999999999999999999999999999999999999/dossie', 'POST')).status).toBe(404);
    expect((await call('/api/propostas/abc%2Ceq.1/dossie', 'POST')).status).toBe(400);
  });

  it('#130 GET no caminho do pedido dá 405', async () => {
    const { call } = await setup({ ask: answering(kitGoodRaw()) });
    expect((await call(`/api/propostas/${KIT_ACCESS_KEY}/dossie`, 'GET')).status).toBe(405);
  });

  it('AC-4 se a nova geração falha, o dossiê pronto anterior continua e o pedido fecha', async () => {
    const failing = vi.fn(async () => {
      throw new ClaudeError('timeout', 'sem resposta em 45 s');
    }) as unknown as AskWithUsage;
    const { ask, settle, fake, drawer } = await setup({ ask: failing, suggestions: [okRow()] });
    expect((await ask()).status).toBe(202);
    await settle();
    expect(suggestions(fake)).toHaveLength(1);
    expect(suggestions(fake)[0]).toMatchObject({ status: 'ok', trigger: 'event', updated_at: '2026-11-15T10:15:00.000Z' });
    expect(requests(fake)[0]).toMatchObject({ finished_at: NOW.toISOString() });
    expect((await drawer()).status).toBe('ready');
  });

  it('AC-4 se a nova geração dá certo, troca o dossiê pronto pelo novo', async () => {
    const fresh = { ...kitGoodRaw(), supplier_history: 'Histórico refeito.' };
    const { ask, settle, fake } = await setup({ ask: answering(fresh), suggestions: [okRow()] });
    expect((await ask()).status).toBe(202);
    await settle();
    expect(suggestions(fake)[0]).toMatchObject({ status: 'ok', trigger: 'on_demand', output: fresh });
  });

  it('#130 a falha sem dossiê anterior grava o erro com o motivo, e a gaveta mostra invalid_shape', async () => {
    const { ask, settle, fake, drawer } = await setup({ ask: answering({ summary: 'x' }) });
    expect((await ask()).status).toBe(202);
    await settle();
    expect(suggestions(fake)[0]).toMatchObject({ status: 'error', reason: 'invalid_shape', trigger: 'on_demand', attempts: 1 });
    expect(await drawer()).toMatchObject({ status: 'unavailable', reason: 'invalid_shape', notice: expect.stringContaining('fora do formato') });
  });

  it('#130 o prazo sob demanda cabe na janela do waitUntil (uns 30 s) e é menor que o do Cron', () => {
    expect(ON_DEMAND_ASK_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(ON_DEMAND_ASK_TIMEOUT_MS).toBeLessThan(ASK_TIMEOUT_MS);
  });

  it('#130 a resposta atrasada vira erro timeout gravado, o pedido fecha e a gaveta mostra timeout', async () => {
    // A API que nunca responde: o fetch só termina quando o prazo do cliente aborta o pedido.
    const hanging: FetchFn = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const late = onDemandAskWithUsage({ kind: 'api-key', apiKey: 'sk-segredo' }, { fetch: hanging, timeoutMs: 20 });
    const { ask, settle, fake, drawer } = await setup({ ask: late });
    expect((await ask()).status).toBe(202);
    await settle();
    expect(suggestions(fake)[0]).toMatchObject({ status: 'error', reason: 'timeout', trigger: 'on_demand' });
    expect(String(suggestions(fake)[0]?.error)).not.toContain('sk-segredo');
    expect(requests(fake)[0]?.finished_at).toBe(NOW.toISOString());
    expect(await drawer()).toMatchObject({ status: 'unavailable', reason: 'timeout', notice: expect.stringContaining('demorou demais') });
  });

  it('#130 sem credencial do Claude, 202, a linha de erro claude_failed e a gaveta mostra indisponível', async () => {
    const { ask, settle, fake, drawer, context } = await setup();
    expect((await ask()).status).toBe(202);
    await settle();
    expect(suggestions(fake)[0]).toMatchObject({ status: 'error', reason: 'claude_failed', trigger: 'on_demand', output: null });
    expect(context).not.toHaveBeenCalled();
    expect(requests(fake)[0]?.finished_at).toBe(NOW.toISOString());
    expect(await drawer()).toMatchObject({ status: 'unavailable', reason: 'claude_failed' });
    expect(suggestions(fake)[0]?.usage).toBeNull();
  });
});

describe('#38 o uso de tokens gravado na linha do dossiê sob demanda', () => {
  /** A Messages API falsa: uma resposta por chamada, com o campo `usage`. */
  const messagesApi = (bodies: unknown[]): FetchFn => {
    let i = 0;
    return async () => {
      const body = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    };
  };
  const credentials = { kind: 'api-key', apiKey: 'sk-segredo' } as const;

  it('o pedido na gaveta grava o dossiê com trigger on_demand e os tokens da resposta', async () => {
    const fetch = messagesApi([
      { content: [{ type: 'tool_use', name: 'responder', input: kitGoodRaw() }], usage: { input_tokens: 2100, output_tokens: 512 } },
    ]);
    const { ask, settle, fake } = await setup({ ask: onDemandAskWithUsage(credentials, { fetch }) });
    expect((await ask()).status).toBe(202);
    await settle();
    expect(suggestions(fake)[0]).toMatchObject({
      status: 'ok',
      trigger: 'on_demand',
      usage: { input_tokens: 2100, output_tokens: 512 },
    });
  });

  it('a resposta fora do formato grava o erro e o uso já gasto', async () => {
    const fetch = messagesApi([{ content: [{ type: 'text', text: 'oi' }], usage: { input_tokens: 700, output_tokens: 9 } }]);
    const { ask, settle, fake } = await setup({ ask: onDemandAskWithUsage(credentials, { fetch }) });
    expect((await ask()).status).toBe(202);
    await settle();
    expect(suggestions(fake)[0]).toMatchObject({
      status: 'error',
      reason: 'invalid_shape',
      trigger: 'on_demand',
      usage: { input_tokens: 700, output_tokens: 9 },
    });
  });

  it('a falha antes de qualquer resposta (5xx) grava usage nulo', async () => {
    const fetch: FetchFn = async () => new Response('', { status: 502 });
    const { ask, settle, fake } = await setup({ ask: onDemandAskWithUsage(credentials, { fetch }) });
    expect((await ask()).status).toBe(202);
    await settle();
    expect(suggestions(fake)[0]).toMatchObject({ status: 'error', reason: 'claude_failed', trigger: 'on_demand' });
    expect(suggestions(fake)[0]?.usage).toBeNull();
    expect(String(suggestions(fake)[0]?.error)).not.toContain('sk-segredo');
  });
});

describe('#130 GET /api/propostas/:chave enquanto o Claude trabalha', () => {
  it('AC-3 com um pedido aberto, o dossiê vem generating; ao terminar, vem ready', async () => {
    // O Claude falso só responde quando o teste solta, para a gaveta ler no meio da geração.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.fn(async () => {
      await gate;
      return { value: kitGoodRaw(), usage: null };
    }) as unknown as AskWithUsage;
    const { ask, settle, drawer } = await setup({ ask: slow });
    expect((await ask()).status).toBe(202);
    expect(await drawer()).toEqual({
      status: 'generating',
      trigger: 'on_demand',
      requestedBy: ANALISTA,
      requestedAt: NOW.toISOString(),
    });
    release();
    await settle();
    expect((await drawer()).status).toBe('ready');
  });

  it('#130 um pedido abandonado não deixa a gaveta presa em generating', async () => {
    const stale = { input_key: KIT_ACCESS_KEY, requested_by: ANALISTA, requested_at: '2026-11-15T12:00:00.000Z', finished_at: null };
    const { drawer } = await setup({ requests: [stale] });
    expect(await drawer()).toMatchObject({ status: 'unavailable', reason: 'pending' });
  });
});

describe('#130 #38 o pedido aberto pelo evento', () => {
  const eventRow = () => ({ input_key: KIT_ACCESS_KEY, requested_by: 'claude', requested_at: '2026-11-15T12:59:00.000Z', finished_at: null, trigger: 'event' });

  it('#38 AC-1 a gaveta mostra generating com trigger event enquanto o evento roda', async () => {
    const { drawer } = await setup({ ask: answering(kitGoodRaw()), requests: [eventRow()] });
    expect(await drawer()).toEqual({ status: 'generating', trigger: 'event', requestedBy: 'claude', requestedAt: '2026-11-15T12:59:00.000Z' });
  });

  it('#130 corrida: o clique na gaveta durante o evento recebe 409 e não chama o Claude', async () => {
    const claude = answering(kitGoodRaw());
    const { ask, settle, fake } = await setup({ ask: claude, requests: [eventRow()] });
    expect((await ask()).status).toBe(409);
    await settle();
    expect(claude).not.toHaveBeenCalled();
    expect(requests(fake)).toHaveLength(1);
  });

  it('#130 a linha do evento não conta no limite de pedidos da pessoa', async () => {
    const done = (at: string, trigger: string) => ({ input_key: KIT_ACCESS_KEY, requested_by: 'x', requested_at: at, finished_at: at, trigger });
    const { ask } = await setup({
      ask: answering(kitGoodRaw()),
      requests: [done('2026-11-15T12:10:00.000Z', 'event'), done('2026-11-15T12:20:00.000Z', 'on_demand'), done('2026-11-15T12:30:00.000Z', 'on_demand')],
    });
    expect((await ask()).status).toBe(202);
  });
});
