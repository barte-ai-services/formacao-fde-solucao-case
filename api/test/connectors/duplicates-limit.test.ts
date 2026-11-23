// #356 AC-4 O teto de títulos por passo no bloqueio dos duplicados: um update por título, então o laço precisa de teto na rodada.
import { describe, expect, it } from 'vitest';
import { blockDuplicateTitles } from '../../src/connectors/duplicate-settler.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

const NOW = new Date('2026-11-22T12:00:00Z');
const key = (n: number) => `3526119443343200014355001000089${String(n).padStart(13, '0')}`;

/** #356 AC-4 `count` notas E6 com o título ainda lançado. */
function world(count: number) {
  const keys = Array.from({ length: count }, (_, i) => key(i));
  const fake = new FakePostgrest({
    invoices: keys.map((access_key) => ({ access_key, classification: 'E6' })),
    titles: keys.map((invoice_access_key) => ({ invoice_access_key, amount_cents: 1000, due_on: '2026-11-20', state: 'lancado', updated_at: null })),
  });
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  return { fake, rest };
}

describe('#356/AC-4 o teto de títulos bloqueados por chamada', () => { // ADR-002
  it('com o teto, bloqueia só esse tanto, gasta 2 leituras mais um update por título, e a chamada seguinte bloqueia o resto', async () => { // ADR-002
    const { fake, rest } = world(20);
    expect(await blockDuplicateTitles(rest, () => NOW, 9)).toEqual({ blocked: 9, failed: 0 });
    expect(fake.requests).toHaveLength(2 + 9);
    expect(fake.rows('titles').filter((t) => t.state === 'bloqueado')).toHaveLength(9);
    expect(await blockDuplicateTitles(rest, () => NOW, 9)).toEqual({ blocked: 9, failed: 0 });
    expect(await blockDuplicateTitles(rest, () => NOW, 9)).toEqual({ blocked: 2, failed: 0 });
    expect(fake.rows('titles').every((t) => t.state === 'bloqueado')).toBe(true);
  });

  it('sem o teto, bloqueia todos de uma vez, como fora da rodada', async () => { // ADR-002
    const { rest } = world(20);
    expect(await blockDuplicateTitles(rest, () => NOW)).toEqual({ blocked: 20, failed: 0 });
  });
});
