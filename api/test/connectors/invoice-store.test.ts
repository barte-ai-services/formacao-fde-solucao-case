// #362 A leitura das notas guardadas valida o estado contra os quatro do domínio (ADR-002).
import { describe, expect, it } from 'vitest';
import { SupabaseInvoiceStore } from '../../src/connectors/invoice-store.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

const store = (state: string) =>
  new SupabaseInvoiceStore(
    new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: new FakePostgrest({ invoices: [{ access_key: 'k1', state, check_error: null }] }).fetch }),
  );

describe('#362 listStored', () => { // ADR-002
  it.each(['a_conferir', 'conferida', 'com_proposta', 'decidida'])('aceita o estado %s do domínio', async (state) => {
    expect(await store(state).listStored()).toEqual([{ accessKey: 'k1', state, checkError: null }]);
  });

  it('recusa a linha com um estado fora dos quatro do domínio, sem dizer os dados', async () => {
    await expect(store('arquivada').listStored()).rejects.toMatchObject({ operation: 'parse', table: 'invoices', detail: 'linha 0 fora do formato esperado' });
  });
});
