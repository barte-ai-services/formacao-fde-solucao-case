import { describe, expect, it } from 'vitest';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { wmsDockActionOutbox } from '../../src/connectors/wms-dock-action.js';
import { supabaseDockSource } from '../../src/dock/dock-source.js';
import { DockAction } from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitInvoiceRows, kitNotes, kitNotesOf } from './kit-invoices.js';

const rest = (fake: FakePostgrest) => new SupabaseRest({ url: 'https://supabase.test', secretKey: 'sb_teste', fetch: fake.fetch });

describe('supabaseDockSource: a leitura da doca no Supabase (#72)', () => {
  it('#43/AC-4 lê só as notas do dia, com as colunas que a doca usa', async () => {
    const fake = new FakePostgrest({ invoices: kitInvoiceRows() });

    const invoices = await supabaseDockSource(rest(fake)).invoicesOn('2026-11-11');

    expect(invoices).toHaveLength(kitNotes().filter((n) => n.data_emissao === '2026-11-11').length);
    const [note] = kitNotesOf('CD-03', '2026-11-11');
    expect(invoices.find((i) => i.accessKey === note?.chave)).toEqual({
      accessKey: note?.chave,
      number: String(note?.numero),
      supplierId: note?.fornecedor_id,
      store: 'CD-03',
      issuedOn: '2026-11-11',
      items: note?.itens.map((i) => ({ sku: i.sku, description: i.descricao, quantity: { amount: i.quantidade, unit: i.unidade } })),
    });
    const url = new URL(fake.requests[0]?.url ?? '');
    expect(url.searchParams.get('issued_on')).toBe('eq.2026-11-11');
    expect(url.searchParams.get('select')).toBe('access_key,number,supplier_id,store,issued_on,items');
  });

  it('#43/AC-1 lê as ações publicadas na caixa de saída do WMS', async () => {
    const fake = new FakePostgrest({ invoices: kitInvoiceRows() });
    const [note] = kitNotesOf('CD-03', '2026-11-11');
    await wmsDockActionOutbox(rest(fake)).publish({ invoiceAccessKey: note?.chave ?? '', action: DockAction.refuse() });

    const published = await supabaseDockSource(rest(fake)).published();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ invoiceAccessKey: note?.chave, action: { kind: 'recusar' } });
  });

  it('linha fora do formato vira erro sem repetir os dados', async () => {
    const fake = new FakePostgrest({ invoices: [{ access_key: 'X', number: 1, supplier_id: 'F01', store: 'CD-03', issued_on: '2026-11-11', items: [] }] });

    const error = await supabaseDockSource(rest(fake)).invoicesOn('2026-11-11').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SupabaseRestError);
    expect(String(error)).not.toContain('F01');
  });
});
