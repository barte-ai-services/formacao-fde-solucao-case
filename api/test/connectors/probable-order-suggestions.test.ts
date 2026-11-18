import { describe, expect, it } from 'vitest';
import { SupabaseProbableOrderSuggestions } from '../../src/connectors/probable-order-suggestions.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

// #65: o Worker lê as sugestões que a rodada do Claude grava em claude_suggestions.
const row = (key: string, status: string, output: unknown, task = 'probable-order') => ({
  task,
  input_key: key,
  input: {},
  output,
  status,
  model: 'claude-opus-5-5',
  error: null,
  created_at: '2026-11-15T10:00:00Z',
});

describe('SupabaseProbableOrderSuggestions (#34)', () => {
  const fake = new FakePostgrest({
    claude_suggestions: [
      row('K1', 'ok', { orderId: 'OC-1', reason: 'mesmo destino' }),
      row('K2', 'ok', { orderId: null, reason: 'nenhuma bate' }),
      row('K3', 'erro', null),
      row('K4', 'ok', { ordem: 'lixo' }),
      row('K5', 'ok', { orderId: 'OC-9', reason: 'outra tarefa' }, 'item-description'),
      row('K6', 'ok', { orderId: 'OC-6', reason: 'fora das chaves pedidas' }),
    ],
  });
  const store = new SupabaseProbableOrderSuggestions(
    new SupabaseRest({ url: 'https://f', secretKey: 'sb_secret_fake', fetch: fake.fetch }),
  );

  it('#34/AC-2: só a linha ok desta tarefa, das chaves pedidas e no formato, vira sugestão', async () => {
    const found = await store.listSuggestions(['K1', 'K2', 'K3', 'K4', 'K5']);
    expect([...found.keys()].sort()).toEqual(['K1', 'K2']);
    expect(found.get('K1')).toEqual({ orderId: 'OC-1', reason: 'mesmo destino' });
    expect(found.get('K2')).toEqual({ orderId: null, reason: 'nenhuma bate' });
  });

  it('#34: sem chaves, não chama o PostgREST', async () => {
    const before = fake.requests.length;
    expect((await store.listSuggestions([])).size).toBe(0);
    expect(fake.requests).toHaveLength(before);
  });
});
