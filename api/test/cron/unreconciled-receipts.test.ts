import { describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { findUnreconciledReceipts } from '../../src/cron/unreconciled-receipts.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

describe('#69/AC-1 recebimentos que não conciliam, sobre os mocks do WMS', () => {
  it('registra os 9 sem chave e os 4 com chave de nota fora da SEFAZ, pelos ids', async () => {
    const tables = kitTables();
    const fake = new FakePostgrest(tables);
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    const { captureDeps } = supabaseConnectors(rest);

    const found = await findUnreconciledReceipts(captureDeps);

    expect(found.noKey).toEqual([
      'RC-9356', 'RC-9362', 'RC-9368', 'RC-9372', 'RC-9381', 'RC-9389', 'RC-9393', 'RC-9399', 'RC-9401',
    ]);
    expect(found.keyWithoutInvoice).toEqual(['RC-9316', 'RC-9325', 'RC-9341', 'RC-9348']);
  });
});
