import { describe, expect, it } from 'vitest';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { SupabaseDossierSource } from '../../src/dossier/source.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

const KEY = '35261126804190000106550010000727681835351811';
const GERADO = '2026-11-15T12:00:00.000Z';

const suggestion = (overrides: Record<string, unknown> = {}) => ({
  task: 'dossier',
  input_key: KEY,
  input: { invoiceAccessKey: KEY },
  output: { summary: 'r', divergences: [], supplier_history: 'h' },
  status: 'ok',
  model: 'claude-opus-5-5',
  error: null,
  generated_at: GERADO,
  ...overrides,
});

const setup = (rows: Record<string, unknown>[]) => {
  const fake = new FakePostgrest({ claude_suggestions: rows });
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  return { fake, source: new SupabaseDossierSource(rest) };
};

describe('SupabaseDossierSource', () => {
  it('#38/AC-1 lê a sugestão do dossiê da nota em claude_suggestions', async () => {
    const { fake, source } = setup([suggestion(), suggestion({ task: 'outra', output: { x: 1 } })]);
    expect(await source.find(KEY)).toEqual({
      status: 'ok',
      output: { summary: 'r', divergences: [], supplier_history: 'h' },
      model: 'claude-opus-5-5',
      generatedAt: GERADO,
    });
    const url = new URL(fake.requests[0]!.url);
    expect(url.pathname).toBe('/rest/v1/claude_suggestions');
    expect(url.searchParams.get('task')).toBe('eq.dossier');
    expect(url.searchParams.get('input_key')).toBe(`eq.${KEY}`);
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('#38/AC-4 sem linha: null', async () => {
    expect(await setup([]).source.find(KEY)).toBeNull();
  });

  it('#38/AC-4 status erro chega como erro, sem o model', async () => {
    const { source } = setup([suggestion({ status: 'erro', output: null, model: null, error: 'timeout' })]);
    expect(await source.find(KEY)).toEqual({ status: 'erro', output: null, model: null, generatedAt: GERADO });
  });

  it('linha fora do formato vira erro, sem os dados na mensagem', async () => {
    const { source } = setup([suggestion({ status: 'talvez' })]);
    await expect(source.find(KEY)).rejects.toBeInstanceOf(SupabaseRestError);
  });

  it('recusa chave que não é uma chave de acesso, antes de ir ao banco', async () => {
    const { fake, source } = setup([]);
    await expect(source.find('x&task=eq.outra')).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
});
