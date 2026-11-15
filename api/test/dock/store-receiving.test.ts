import { describe, expect, it } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { receivingPlace } from '../../src/dock/receiving-place.js';
import { publishDecidedDockActions, publishDecidedStoreActions } from '../../src/dock/publish-decided.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

// #135 A ação no recebimento vai para o lugar do destino: doca do CD (WMS) ou app da loja. Notas do kit.

const NOW = new Date('2026-11-15T12:00:00Z');
const ACCESS: Env = { ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com' };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const verifier: AccessVerifier = { verify: async () => ({ ok: true, identity: { email: 'loja@jachegou.test' } }) };

async function swept() {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { captureDeps } = supabaseConnectors(rest);
  await captureInvoices(captureDeps);
  await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, now: () => NOW });
  const dock = await publishDecidedDockActions(rest);
  const store = await publishDecidedStoreActions(rest);
  const storeOf = new Map(fake.rows('invoices').map((r) => [String(r.access_key), r] as const));
  const worker = createWorker({ verifier, dock: { supabase: () => rest, today: () => '2026-11-15' } });
  const get = (path: string) =>
    worker.fetch(new Request(`https://worker.test${path}`, { headers: { 'Cf-Access-Jwt-Assertion': 't' } }), ACCESS, ctx);
  return { fake, dock, store, storeOf, get };
}

describe('#135 o lugar do recebimento sai do destino', () => {
  it('#135/AC-1 LJ-* é o app da loja; CD-* é a doca do CD', () => {
    expect(receivingPlace('LJ-012')).toBe('app_loja');
    expect(receivingPlace('CD-03')).toBe('doca_cd');
  });
});

describe('#135 AC-1 a publicação vai para a caixa certa', () => {
  it('#135/AC-1 nota de loja só na outbox_store_actions; nota de CD só na outbox_dock_actions', async () => {
    const { fake, dock, store, storeOf } = await swept();
    expect(store.published).toBeGreaterThan(0);
    expect(dock.published).toBeGreaterThan(0);
    const storeRows = fake.rows('outbox_store_actions');
    const dockRows = fake.rows('outbox_dock_actions');
    expect(storeRows.length).toBe(store.published);
    for (const r of storeRows) expect(String(storeOf.get(String(r.invoice_access_key))?.store)).toMatch(/^LJ-/);
    for (const r of dockRows) expect(String(storeOf.get(String(r.invoice_access_key))?.store)).toMatch(/^CD-/);
  });

  it('#135/AC-1 a mensagem da loja leva a loja, e a varredura é idempotente', async () => {
    const { fake, storeOf } = await swept();
    const row = fake.rows('outbox_store_actions')[0]!;
    expect((row.payload as { store: string }).store).toBe(storeOf.get(String(row.invoice_access_key))?.store);
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    const before = fake.rows('outbox_store_actions').length;
    expect(await publishDecidedStoreActions(rest)).toEqual({ published: 0 });
    expect(fake.rows('outbox_store_actions')).toHaveLength(before);
  });
});

describe('#135 AC-2 as telas leem cada uma o seu lugar', () => {
  it('#135/AC-2 /api/doca lista só destinos de CD e recusa destino de loja', async () => {
    const { get, storeOf } = await swept();
    const store = [...storeOf.values()].find((r) => String(r.store).startsWith('LJ-'))!;
    const board = (await (await get(`/api/doca?data=${store.issued_on}`)).json()) as { destinations: string[] };
    expect(board.destinations.every((d) => d.startsWith('CD-'))).toBe(true);
    expect((await get(`/api/doca?destino=${store.store}&data=${store.issued_on}`)).status).toBe(400);
  });

  it('#135/AC-2 /api/recebimento-loja lista só a loja pedida, com a ação publicada', async () => {
    const { fake, get, storeOf } = await swept();
    const published = new Set(fake.rows('outbox_store_actions').map((r) => String(r.invoice_access_key)));
    const sample = [...storeOf.values()].find((r) => published.has(String(r.access_key)))!;
    const res = await get(`/api/recebimento-loja?loja=${sample.store}&data=${sample.issued_on}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      destination: string;
      destinations: string[];
      rows: { invoiceAccessKey: string; status: { kind: string } }[];
    };
    expect(body.destination).toBe(sample.store);
    expect(body.destinations.every((d) => d.startsWith('LJ-'))).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    for (const r of body.rows) expect(storeOf.get(r.invoiceAccessKey)?.store).toBe(sample.store);
    expect(body.rows.find((r) => r.invoiceAccessKey === sample.access_key)?.status.kind).toBe('acao');
    expect((await get(`/api/recebimento-loja?loja=CD-03&data=${sample.issued_on}`)).status).toBe(400);
  });
});
