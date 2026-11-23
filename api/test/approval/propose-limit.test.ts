// #356 AC-4 O teto de notas propostas por passo: o que passa do teto fica conferido e a rodada seguinte propõe.
import { describe, expect, it } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

const NOW = new Date('2026-11-22T12:00:00Z');

async function world() {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { captureDeps } = supabaseConnectors(rest);
  await captureInvoices(captureDeps);
  const propose = (limit?: number) =>
    proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, now: () => NOW, ...(limit === undefined ? {} : { limit }) });
  return { fake, propose };
}

describe('#356/AC-4 o teto de propostas por chamada', () => { // ADR-002
  it('com o teto, propõe só esse tanto de notas conferidas e as seguintes ficam para a chamada seguinte, sem repetir nem perder', async () => { // ADR-002
    const { fake, propose } = await world();
    expect((await propose(30)).proposed).toBe(30);
    expect(fake.rows('proposals')).toHaveLength(30);
    expect((await propose(30)).proposed).toBe(30);
    expect((await propose(30)).proposed).toBe(20);
    expect(fake.rows('proposals')).toHaveLength(80);
    expect(new Set(fake.rows('proposals').map((p) => p.invoice_access_key)).size).toBe(80);
    expect((await propose(30)).proposed).toBe(0);
  });

  it('o gasto de uma chamada no teto não passa do que a lista declara (16)', async () => { // ADR-002
    const { fake, propose } = await world();
    const before = fake.requests.length;
    await propose(30);
    expect(fake.requests.length - before).toBeLessThanOrEqual(16);
  });

  it('sem o teto, propõe as 80 de uma vez, como fora da rodada', async () => { // ADR-002
    const { propose } = await world();
    expect((await propose()).proposed).toBe(80);
  });
});
