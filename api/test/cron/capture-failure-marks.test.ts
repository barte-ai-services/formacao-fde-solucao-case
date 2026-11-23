// #356 AC-4 As marcas de falha da conferência (um update por nota que quebrou) saem da captura, que é crítica, e ganham passo e teto próprios.
import { describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices, markCheckFailures } from '../../src/cron/capture.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

/** #356 AC-4 As `count` primeiras notas do kit chegam com a data de emissão fora do formato; a conferência quebra nas 9 em que a data pesa (E7). */
function brokenWorld(count: number) {
  const tables = kitTables();
  for (const nota of tables.kit_notas!.slice(0, count)) nota.data_emissao = '09/11/2026';
  const fake = new FakePostgrest(tables);
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch, memoizeReads: true });
  return { fake, deps: supabaseConnectors(rest).captureDeps };
}

describe('#356/AC-4 a captura sem as marcas de falha', () => { // ADR-002
  it('com markFailures falso, a captura não escreve as notas que quebraram e devolve a lista delas', async () => { // ADR-002
    const { fake, deps } = brokenWorld(80);
    const before = fake.requests.length;
    const result = await captureInvoices(deps, { markFailures: false });
    expect(result).toMatchObject({ seen: 80, inserted: 80, checked: 71, failed: 9 });
    expect(result.failures).toHaveLength(9);
    expect(fake.requests.length - before).toBe(15); // #356 AC-4 com ou sem notas quebradas; mais 1 do adaptador (as sugestões guardadas) são os 16 declarados (#362: a rodada lê cada consulta uma vez)
    expect(fake.rows('invoices').filter((r) => r.check_error)).toHaveLength(0);
  });

  it('as marcas vão até o teto por chamada, e cada nota marcada leva o motivo dela', async () => { // ADR-002
    const { fake, deps } = brokenWorld(80);
    const { failures } = await captureInvoices(deps, { markFailures: false });
    const before = fake.requests.length;
    await markCheckFailures(deps, failures ?? [], 5);
    expect(fake.requests.length - before).toBe(5);
    const marked = fake.rows('invoices').filter((r) => r.check_error);
    expect(marked).toHaveLength(5);
    expect(String(marked[0]?.check_error)).toContain('09/11/2026');
  });

  it('sem o teto, a captura de sempre marca todas dentro dela', async () => { // ADR-002
    const { fake, deps } = brokenWorld(80);
    const result = await captureInvoices(deps);
    expect(result).toEqual({ seen: 80, inserted: 80, checked: 71, failed: 9 });
    expect(fake.rows('invoices').filter((r) => r.check_error)).toHaveLength(9);
  });

  it('a nota já marcada com o mesmo motivo não é atualizada de novo, e em rodadas seguidas as 9 ficam marcadas sob o teto de 5', async () => { // ADR-002
    const { fake, deps } = brokenWorld(80);
    const updates = (since: number) => fake.requests.slice(since).filter((r) => r.method === 'PATCH').length;
    const perRound: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      const { failures } = await captureInvoices(deps, { markFailures: false });
      const since = fake.requests.length;
      await markCheckFailures(deps, failures ?? [], 5);
      perRound.push(updates(since));
    }
    // #356 AC-4 sem o filtro as mesmas 5 notas seriam marcadas toda rodada e as 4 de trás nunca; com ele: 5, 4 e depois nada
    expect(perRound).toEqual([5, 4, 0, 0]);
    expect(fake.rows('invoices').filter((r) => r.check_error)).toHaveLength(9);
  });

  it('a nota marcada com um motivo diferente é marcada de novo com o motivo novo', async () => { // ADR-002
    const { fake, deps } = brokenWorld(80);
    const { failures } = await captureInvoices(deps, { markFailures: false });
    await markCheckFailures(deps, failures ?? [], 9);
    for (const row of fake.rows('invoices').filter((r) => r.check_error)) row.check_error = 'motivo antigo';
    const again = await captureInvoices(deps, { markFailures: false });
    const since = fake.requests.length;
    await markCheckFailures(deps, again.failures ?? [], 9);
    expect(fake.requests.slice(since).filter((r) => r.method === 'PATCH')).toHaveLength(9);
    expect(fake.rows('invoices').filter((r) => String(r.check_error).includes('09/11/2026'))).toHaveLength(9);
  });

  it('a leitura das chaves a conferir traz o motivo guardado na mesma requisição', async () => { // ADR-002
    const { fake, deps } = brokenWorld(80);
    const { failures } = await captureInvoices(deps, { markFailures: false });
    await markCheckFailures(deps, failures ?? [], 1);
    const since = fake.requests.length;
    const pending = (await deps.invoices.listStored()).filter((s) => s.state === 'a_conferir');
    expect(fake.requests.length - since).toBe(1);
    expect(pending.filter((p) => p.checkError !== null)).toHaveLength(1);
    expect(pending.filter((p) => p.checkError === null)).toHaveLength(pending.length - 1);
  });
});
