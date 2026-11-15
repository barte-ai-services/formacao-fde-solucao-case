import { describe, expect, it } from 'vitest';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

const SECRET = 'sb_secret_teste_nao_real';

describe('#59/AC-1 cliente PostgREST', () => {
  it('pagina o select pelo cabeçalho Range até a última página', async () => {
    const fake = new FakePostgrest({ t: Array.from({ length: 5 }, (_, i) => ({ id: i })) });
    const rest = new SupabaseRest({ url: 'https://x.supabase.co/', secretKey: SECRET, fetch: fake.fetch, pageSize: 2 });
    const rows = await rest.select('t');
    expect(rows).toHaveLength(5);
    expect(fake.requests.map((r) => r.headers.Range)).toEqual(['0-1', '2-3', '4-5']);
    expect(fake.requests[0]?.url).toBe('https://x.supabase.co/rest/v1/t?select=*');
  });

  it('chave sb_ vai só no apikey; a legada também no Authorization', async () => {
    const fake = new FakePostgrest();
    await new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: fake.fetch }).select('t');
    await new SupabaseRest({ url: 'https://x', secretKey: 'eyJlegado', fetch: fake.fetch }).select('t');
    expect(fake.requests[0]?.headers.apikey).toBe(SECRET);
    expect(fake.requests[0]?.headers.Authorization).toBeUndefined();
    expect(fake.requests[1]?.headers.Authorization).toBe('Bearer eyJlegado');
  });

  it('regra 1: insert com on_conflict ignora a duplicada e devolve só o que entrou', async () => {
    const fake = new FakePostgrest({ t: [{ k: 'a' }] });
    const rest = new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: fake.fetch });
    const inserted = await rest.insert('t', [{ k: 'a' }, { k: 'b' }], { onConflict: 'k' });
    expect(inserted).toEqual([{ k: 'b' }]);
    expect(fake.requests[0]?.url).toContain('on_conflict=k');
    expect(fake.requests[0]?.headers.Prefer).toContain('resolution=ignore-duplicates');
  });

  it('upsert atualiza a linha existente pela restrição', async () => {
    const fake = new FakePostgrest({ t: [{ k: 'a', v: 1 }] });
    const rest = new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: fake.fetch });
    await rest.upsert('t', [{ k: 'a', v: 2 }], 'k');
    expect(fake.rows('t')).toEqual([{ k: 'a', v: 2 }]);
  });

  it('o erro diz operação, tabela e status, e nunca a chave', async () => {
    const rest = new SupabaseRest({
      url: 'https://x',
      secretKey: SECRET,
      fetch: async () => new Response('{"message":"permission denied"}', { status: 401 }),
    });
    const error = await rest.select('t').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseRestError);
    expect(String((error as Error).message)).toContain('select em t falhou (HTTP 401)');
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it('update e delete sem filtro são recusados', async () => {
    const rest = new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: new FakePostgrest().fetch });
    await expect(rest.delete('t', {})).rejects.toBeInstanceOf(SupabaseRestError);
    await expect(rest.update('t', {}, { v: 1 })).rejects.toBeInstanceOf(SupabaseRestError);
  });
});
