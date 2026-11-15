import { describe, expect, it } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import { blockDuplicateTitles } from '../../src/connectors/duplicate-settler.js';
import { SupabaseDuplicatesReader } from '../../src/connectors/duplicates-reader.js';
import { ErpPayablesConnector } from '../../src/connectors/erp-payables.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest, type FetchFn } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

const NF012 = '35261194433432000143550010000894281178831290';
const ORIGINAL_NF012 = '35261194433432000143550010000894101464288543';
const NOW = new Date('2026-11-15T12:00:00Z');
// #142: 4 reemissões e 5 reenvios (mesma chave já lançada no ERP).
const E6_IDS = ['NF-012', 'NF-058', 'NF-060', 'NF-074', 'NF-020', 'NF-030', 'NF-041', 'NF-064', 'NF-075'].sort();

/** A esteira do Cron como na main: captura, proposta do #63, e depois o bloqueio dos títulos E6. */
async function pipeline(fetchWrapper?: (inner: FetchFn) => FetchFn) {
  const fake = new FakePostgrest(kitTables());
  const fetch = fetchWrapper ? fetchWrapper(fake.fetch) : fake.fetch;
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch });
  const { captureDeps } = supabaseConnectors(rest);
  await captureInvoices(captureDeps);
  await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, now: () => NOW });
  const reader = new SupabaseDuplicatesReader(rest, new ErpPayablesConnector(rest));
  return { fake, rest, reader };
}

const kitIdByKey = () => new Map(kitTables().kit_notas!.map((n) => [String(n.chave), String(n.nota_id)]));

function e6Keys(fake: FakePostgrest): Set<string> {
  return new Set(fake.rows('invoices').filter((i) => i.classification === 'E6').map((i) => String(i.access_key)));
}

describe('#31 duplicidade de ponta a ponta na base do kit (offline)', () => {
  it('#31/AC-4 #31/AC-5 regra 3: captura, proposta do #63 e bloqueio: 9 E6, 9 propostas de bloqueio e 9 títulos bloqueados', async () => {
    const { fake, rest } = await pipeline();
    const ids = kitIdByKey();
    const keys = e6Keys(fake);
    expect([...keys].map((k) => ids.get(k)).sort()).toEqual(E6_IDS);

    // Antes do bloqueio, o #63 deixa o título da E6 lançado: a proposta só aguarda aprovação.
    const before = fake.rows('titles').filter((t) => keys.has(String(t.invoice_access_key)));
    expect(before.every((t) => t.state === 'lancado')).toBe(true);

    const result = await blockDuplicateTitles(rest, () => NOW);
    expect(result).toEqual({ blocked: 9, failed: 0 });

    const proposals = fake.rows('proposals').filter((p) => keys.has(String(p.invoice_access_key)));
    expect(proposals).toHaveLength(9);
    for (const p of proposals) {
      const invoice = fake.rows('invoices').find((i) => i.access_key === p.invoice_access_key);
      expect(p).toMatchObject({
        classification: 'E6',
        dock_action: { kind: 'recusar' },
        approval_level: 'bloqueio',
        amount_at_risk_cents: invoice?.total_cents,
        state: 'aguardando_aprovacao',
      });
    }

    const titles = fake.rows('titles').filter((t) => keys.has(String(t.invoice_access_key)));
    expect(titles).toHaveLength(9);
    expect(titles.every((t) => t.state === 'bloqueado' && t.updated_at === NOW.toISOString())).toBe(true);
    expect(titles.find((t) => t.invoice_access_key === NF012)).toMatchObject({ amount_cents: 120960 });
  });

  it('#31/AC-5: a segunda rodada não acha título lançado e não muda nada', async () => {
    const { fake, rest } = await pipeline();
    await blockDuplicateTitles(rest, () => NOW);
    const snapshot = JSON.stringify(fake.rows('titles'));

    expect(await blockDuplicateTitles(rest, () => new Date('2026-11-15T12:15:00Z'))).toEqual({ blocked: 0, failed: 0 });
    expect(JSON.stringify(fake.rows('titles'))).toBe(snapshot);
  });

  it('#31/AC-5: título E6 já liberado não volta a bloqueado', async () => {
    const { fake, rest } = await pipeline();
    const nf012Title = fake.rows('titles').find((t) => t.invoice_access_key === NF012);
    nf012Title!.state = 'liberado';

    expect(await blockDuplicateTitles(rest, () => NOW)).toEqual({ blocked: 8, failed: 0 });
    expect(fake.rows('titles').find((t) => t.invoice_access_key === NF012)?.state).toBe('liberado');
  });

  it('#31/AC-5: título de nota que não é E6 não é tocado', async () => {
    const { fake, rest } = await pipeline();
    const keys = e6Keys(fake);
    const others = () => JSON.stringify(fake.rows('titles').filter((t) => !keys.has(String(t.invoice_access_key))));
    const before = others();

    await blockDuplicateTitles(rest, () => NOW);
    expect(others()).toBe(before);
  });

  it('#31/AC-5: a chave que falha não derruba as outras', async () => {
    let failing = true;
    const { fake, rest } = await pipeline((inner) => (input, init) =>
      failing && init?.method === 'PATCH' && input.includes('/rest/v1/titles') && input.includes(NF012)
        ? Promise.resolve(new Response('{"message":"falhou"}', { status: 503 }))
        : inner(input, init),
    );

    expect(await blockDuplicateTitles(rest, () => NOW)).toEqual({ blocked: 8, failed: 1 });
    expect(fake.rows('titles').find((t) => t.invoice_access_key === NF012)?.state).toBe('lancado');

    failing = false;
    expect(await blockDuplicateTitles(rest, () => NOW)).toEqual({ blocked: 1, failed: 0 });
  });

  it('#31/AC-5 #31/AC-6: o leitor traz o estado do título: lancado antes do bloqueio, bloqueado depois', async () => {
    const { rest, reader } = await pipeline();
    const before = await reader.list();
    expect(before).toHaveLength(9);
    expect(before.every((e) => e.titleState === 'lancado')).toBe(true);

    await blockDuplicateTitles(rest, () => NOW);
    const after = await reader.list();
    expect(after).toHaveLength(9);
    expect(after.every((e) => e.titleState === 'bloqueado')).toBe(true);
  });

  it('#31/AC-6: nota E6 sem título gravado vem com titleState null', async () => {
    const { fake, reader } = await pipeline();
    fake.tables.set('titles', fake.rows('titles').filter((t) => t.invoice_access_key !== NF012));
    const entries = await reader.list();
    expect(entries.find((e) => e.duplicate.accessKey === NF012)?.titleState).toBeNull();
  });

  it('#31/AC-6: o leitor do Supabase lista as nove duplicadas, com o título original da NF-012', async () => {
    const { reader } = await pipeline();

    const entries = await reader.list();
    const ids = kitIdByKey();
    expect(entries.map((e) => ids.get(e.duplicate.accessKey)).sort()).toEqual(E6_IDS);
    const nf012 = entries.find((e) => e.duplicate.accessKey === NF012);
    expect(nf012).toMatchObject({
      duplicate: { number: '89428', supplierId: 'F03', issuedOn: '2026-11-11' },
      original: { accessKey: ORIGINAL_NF012, number: '89410', status: 'lançada' },
      reason: 'titulo_lancado',
    });
    expect(nf012?.duplicate.total.cents).toBe(120960);
    expect(nf012?.blockedAmount.cents).toBe(120960);
  });

  it('#142 AC-4: o reenvio da NF-020 aparece com a nota original (a mesma chave) e o valor barrado', async () => {
    const { reader } = await pipeline();
    const ids = kitIdByKey();
    const entry = (await reader.list()).find((e) => ids.get(e.duplicate.accessKey) === 'NF-020');
    expect(entry).toMatchObject({
      reason: 'titulo_lancado',
      original: { accessKey: entry?.duplicate.accessKey, number: '13137' },
    });
    expect(entry?.blockedAmount.cents).toBe(11871960);
  });

  it('#31/AC-6: sem nota E6 gravada, o leitor devolve a lista vazia', async () => {
    const fake = new FakePostgrest(kitTables());
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    const reader = new SupabaseDuplicatesReader(rest, new ErpPayablesConnector(rest));
    expect(await reader.list()).toEqual([]);
  });

  it('#31/AC-6 #31/AC-7: GET /api/duplicates pelo Worker lê o Supabase atrás do Access', async () => {
    const { rest, reader } = await pipeline();
    await blockDuplicateTitles(rest, () => NOW);
    const verifier: AccessVerifier = { verify: async () => ({ ok: true, identity: { email: 'a@jachegou.test' } }) };
    const worker = createWorker({ verifier, duplicates: () => reader });
    const env: Env = { ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com' };
    const exec = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

    const anonymous = await worker.fetch(new Request('https://worker.test/api/duplicates'), env, exec);
    expect(anonymous.status).toBe(401);

    const response = await worker.fetch(
      new Request('https://worker.test/api/duplicates', { headers: { 'Cf-Access-Jwt-Assertion': 'qualquer' } }),
      env,
      exec,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      count: number;
      duplicates: { duplicate: { accessKey: string }; titleState: string | null }[];
    };
    expect(body.count).toBe(9);
    expect(body.duplicates.every((d) => d.titleState === 'bloqueado')).toBe(true);
    expect(body.duplicates.map((d) => d.duplicate.accessKey)).toContain(NF012);
  });
});
