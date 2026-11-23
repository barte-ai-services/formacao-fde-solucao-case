// #353 GET /api/live mostra o pedido de devolução enviado sozinho, com o selo de quem decidiu (a automação).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

const env: Env = {
  BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co',
  BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake',
  ACCESS_AUD: 'aud',
  ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com',
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const verifier: AccessVerifier = { verify: async (token) => ({ ok: true, identity: { email: token } }) };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const KEY_A = '35261100000000000100550010000000011000000011';
const KEY_B = '35261100000000000100550010000000021000000022';

const call = (fake: FakePostgrest, path = '/api/live') => {
  vi.stubGlobal('fetch', fake.fetch);
  const headers = new Headers({ 'Cf-Access-Jwt-Assertion': 'ana@jachegou.test' });
  return createWorker({ verifier }).fetch(new Request(`https://worker.test${path}`, { headers }), env, ctx);
};

/** #353 Um pedido ao fornecedor já enviado: pela automação (origin demo) ou por uma pessoa (sent_by é o e-mail dela). */
const sent = (id: number, key: string, sentAt: string, over: Record<string, unknown> = {}) => ({
  id, invoice_access_key: key, status: 'sent', origin: 'demo', sent_by: 'automação', sent_at: sentAt, ...over,
});

type Body = { events: Record<string, unknown>[]; since: string | null };

const world = () => ({
  outbox_supplier_emails: [
    sent(1, KEY_A, '2026-11-23T13:20:00.000Z'),
    sent(2, KEY_B, '2026-11-23T13:21:00.000Z', { origin: 'base', sent_by: 'ana@jachegou.test' }),
  ],
  invoices: [
    { access_key: KEY_A, number: '101', captured_at: '2026-11-23T13:00:00Z' },
    { access_key: KEY_B, number: '102', captured_at: '2026-11-23T13:00:00Z' },
  ],
});

describe('#353/AC-1 a tela Ao vivo diz que o pedido saiu sozinho', () => {
  it('#353/AC-1: o pedido enviado pela automação é um passo "Enviado automaticamente", com o selo da automação e a nota que a gaveta abre', async () => {
    const res = await call(new FakePostgrest(world()));
    const body = (await res.json()) as Body;
    expect(res.status).toBe(200);
    expect(body.events).toEqual([
      {
        kind: 'auto_return',
        at: '2026-11-23T13:20:00.000Z',
        actor: 'system',
        actor_name: 'Automático',
        invoice: { access_key: KEY_A, number: '101' },
        step: 'Enviado automaticamente',
      },
    ]);
    expect(body.since).toBe('2026-11-23T13:20:00.000Z');
  });

  it('#353/AC-1: o pedido que uma pessoa enviou não vira passo da automação', async () => {
    const body = (await (await call(new FakePostgrest(world()))).json()) as Body;
    expect(body.events.map((e) => (e.invoice as { number: string }).number)).toEqual(['101']);
  });

  it('#353/AC-1: o pedido sai na ordem do mais novo, junto dos outros passos, e com since só vêm os mais novos que o cursor', async () => {
    const fake = new FakePostgrest({
      ...world(),
      outbox_supplier_emails: [sent(1, KEY_A, '2026-11-23T13:20:00.000Z'), sent(3, KEY_B, '2026-11-23T13:25:00.000Z')],
    });
    const all = (await (await call(fake)).json()) as Body;
    expect(all.events.map((e) => e.at)).toEqual(['2026-11-23T13:25:00.000Z', '2026-11-23T13:20:00.000Z']);
    const next = (await (await call(fake, `/api/live?since=${encodeURIComponent('2026-11-23T13:20:00.000Z')}`)).json()) as Body;
    expect(next.events.map((e) => e.at)).toEqual(['2026-11-23T13:25:00.000Z']);
    const read = fake.requests.find((r) => new URL(r.url).pathname.endsWith('/outbox_supplier_emails') && /sent_at=gt\./.test(decodeURIComponent(r.url)));
    expect(read, 'o cursor vai na consulta').toBeDefined();
  });
});

describe('#353/AC-2 sem pedido enviado sozinho, a tela é a de sempre', () => {
  it('#353/AC-2: sem nenhum pedido da automação a resposta não ganha passo novo', async () => {
    const body = (await (await call(new FakePostgrest({ outbox_supplier_emails: [], invoices: [] }))).json()) as Body;
    expect(body.events).toEqual([]);
  });
});
