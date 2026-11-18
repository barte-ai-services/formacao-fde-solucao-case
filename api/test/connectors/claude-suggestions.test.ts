// #66 O Worker lê as sugestões de casamento por descrição que a rodada do Claude no Cron grava (#171).
import { describe, expect, it } from 'vitest';
import {
  descriptionMatchKey,
  listDescriptionSuggestions,
  storedDescriptionSuggester,
} from '../../src/connectors/claude-suggestions.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

const DESCRIPTION = 'Refrigerante sabor cola 2 L';
const CANDIDATES = ['Refrigerante cola 2 L', 'Água de coco 1 L'];
// #66 sha256 de "Refrigerante sabor cola 2 L\nÁgua de coco 1 L\nRefrigerante cola 2 L", calculado fora do teste.
const KNOWN_KEY = '3378cb991488f45a61048d092b485845e2c22a7174044938b89b12aea78ec7c5';

function rest(fake: FakePostgrest): SupabaseRest {
  return new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
}

describe('#66 sugestões gravadas pelo job do Claude', () => {
  it('AC-2: a chave bate com o sha256 conhecido e independe da ordem dos candidatos', async () => {
    expect(await descriptionMatchKey(DESCRIPTION, CANDIDATES)).toBe(KNOWN_KEY);
    expect(await descriptionMatchKey(DESCRIPTION, [...CANDIDATES].reverse())).toBe(KNOWN_KEY);
  });

  it('AC-2: o sugestor devolve o índice do match na ordem original dos candidatos', async () => {
    const suggester = storedDescriptionSuggester([{ input_key: KNOWN_KEY, output: { match: 'Refrigerante cola 2 L' } }]);
    expect(await suggester.suggest(DESCRIPTION, CANDIDATES)).toBe(0);
    expect(await suggester.suggest(DESCRIPTION, [...CANDIDATES].reverse())).toBe(1);
  });

  it('AC-2: com match fora dos candidatos, ou match null, devolve null', async () => {
    const fora = storedDescriptionSuggester([{ input_key: KNOWN_KEY, output: { match: 'Refrigerante cola zero 2 L' } }]);
    expect(await fora.suggest(DESCRIPTION, CANDIDATES)).toBeNull();
    const nulo = storedDescriptionSuggester([{ input_key: KNOWN_KEY, output: { match: null } }]);
    expect(await nulo.suggest(DESCRIPTION, CANDIDATES)).toBeNull();
  });

  it('AC-2: sem linha para a chave, devolve null', async () => {
    expect(await storedDescriptionSuggester([]).suggest(DESCRIPTION, CANDIDATES)).toBeNull();
  });

  it('AC-2: lê só as linhas ok da tarefa description-match, e só input_key e output', async () => {
    const fake = new FakePostgrest({
      claude_suggestions: [
        { task: 'description-match', input_key: 'k1', input: {}, output: { match: 'A' }, status: 'ok', model: 'm', created_at: 't' },
        { task: 'description-match', input_key: 'k2', input: {}, output: null, status: 'erro', model: 'm', created_at: 't' },
        { task: 'outra-tarefa', input_key: 'k3', input: {}, output: { match: 'B' }, status: 'ok', model: 'm', created_at: 't' },
      ],
    });

    const rows = await listDescriptionSuggestions(rest(fake));

    expect(rows).toEqual([{ input_key: 'k1', output: { match: 'A' } }]);
    const url = new URL(fake.requests.at(-1)?.url ?? '');
    expect(url.searchParams.get('select')).toBe('input_key,output');
    expect(url.searchParams.get('task')).toBe('eq.description-match');
    expect(url.searchParams.get('status')).toBe('eq.ok');
  });

  it('AC-2: linha fora do contrato faz a leitura falhar', async () => {
    const fake = new FakePostgrest({
      claude_suggestions: [{ task: 'description-match', input_key: 'k1', output: { match: 7 }, status: 'ok' }],
    });
    await expect(listDescriptionSuggestions(rest(fake))).rejects.toThrow();
  });
});
