import { describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

describe('#59/AC-5 captura do Cron (offline)', () => {
  it('regra 1: rodar duas vezes deixa 80 notas únicas, todas conferidas', async () => {
    const fake = new FakePostgrest(kitTables());
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    const { captureDeps } = supabaseConnectors(rest);

    const first = await captureInvoices(captureDeps);
    const second = await captureInvoices(captureDeps);

    expect(first).toEqual({ seen: 80, inserted: 80, checked: 80 });
    expect(second).toEqual({ seen: 80, inserted: 0, checked: 0 });
    const rows = fake.rows('invoices');
    expect(new Set(rows.map((r) => r.access_key)).size).toBe(80);
    expect(rows).toHaveLength(80);
    expect(rows.every((r) => r.state === 'conferida' && r.classification === 'MATCH' && r.checked_at)).toBe(true);
    expect(rows.every((r) => Number.isSafeInteger(r.total_cents))).toBe(true);
  });
});
