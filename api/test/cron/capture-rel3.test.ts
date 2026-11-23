import { describe, expect, it } from 'vitest';
import { Divergence, type NamedCheck } from '../../src/domain/index.js';
import { SupabaseInvoiceStore } from '../../src/connectors/invoice-store.js';
import { SupabaseRest, type FetchFn } from '../../src/connectors/supabase-rest.js';
import { anInvoice, emptyContext } from '../domain/fixtures.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

const withDivergence: NamedCheck = {
  id: 'E5',
  run: () => [
    Divergence.of({
      classification: 'E5',
      skus: ['SKU-1'],
      evidence: [{ source: 'erp_compras', reference: 'OC-100', description: 'ordem não encontrada' }],
    }),
  ],
};

/** #362 As notas ainda a conferir, lidas pela leitura única das guardadas. */
async function pendingOf(store: SupabaseInvoiceStore) {
  return (await store.listStored()).filter((s) => s.state === 'a_conferir').map(({ accessKey, checkError }) => ({ accessKey, checkError }));
}

describe('#59 REL-3 divergências gravadas antes do estado', () => {
  it('se as divergências falham, a nota segue a_conferir e a próxima rodada a confere de novo', async () => {
    const fake = new FakePostgrest();
    let failDivergences = true;
    const flaky: FetchFn = (input, init) =>
      failDivergences && input.includes('/rest/v1/divergences')
        ? Promise.resolve(new Response('{"message":"falhou"}', { status: 503 }))
        : fake.fetch(input, init);
    const store = new SupabaseInvoiceStore(new SupabaseRest({ url: 'https://f', secretKey: 'sb_secret_fake', fetch: flaky }));

    const first = anInvoice();
    await store.insertNew([first]);
    first.check(emptyContext(), [withDivergence]);
    await expect(store.saveChecked([first], '2026-11-15T00:00:00Z')).rejects.toMatchObject({ table: 'divergences', status: 503 });
    expect(await pendingOf(store)).toEqual([{ accessKey: first.accessKey, checkError: null }]);
    expect(fake.rows('divergences')).toHaveLength(0);

    failDivergences = false;
    const retry = anInvoice();
    retry.check(emptyContext(), [withDivergence]);
    await store.saveChecked([retry], '2026-11-15T00:15:00Z');
    expect(await pendingOf(store)).toEqual([]);
    expect(fake.rows('invoices')[0]).toMatchObject({ state: 'conferida', classification: 'E5' });
    expect(fake.rows('divergences')).toHaveLength(1);
  });
});
