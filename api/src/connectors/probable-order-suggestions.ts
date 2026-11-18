// Leitura das sugestões de ordem provável que a rodada do Claude grava em claude_suggestions (#65).
import { parseProbableOrderAnswer } from '../agent/probable-order.js';
import type { ProbableOrderSuggestion } from '../domain/index.js';
import { isRecord } from './guards.js';
import type { SupabaseRest } from './supabase-rest.js';

export const PROBABLE_ORDER_TASK = 'probable-order';

export interface ProbableOrderSuggestions {
  /** #65: a sugestão gravada de cada chave pedida que tem linha ok; as outras ficam fora do mapa. */
  listSuggestions(keys: readonly string[]): Promise<Map<string, ProbableOrderSuggestion>>;
}

export class SupabaseProbableOrderSuggestions implements ProbableOrderSuggestions {
  constructor(private readonly rest: SupabaseRest) {}

  async listSuggestions(keys: readonly string[]): Promise<Map<string, ProbableOrderSuggestion>> {
    const found = new Map<string, ProbableOrderSuggestion>();
    if (keys.length === 0) return found;
    const rows = await this.rest.select('claude_suggestions', {
      select: 'input_key,output',
      filters: { task: `eq.${PROBABLE_ORDER_TASK}`, status: 'eq.ok', input_key: `in.(${keys.join(',')})` },
    });
    for (const row of rows) {
      // #65 AC-3: a linha fora do formato conta como sem sugestão; a regra nunca vê um id solto.
      if (!isRecord(row) || typeof row.input_key !== 'string') continue;
      const suggestion = parseProbableOrderAnswer(row.output);
      if (suggestion) found.set(row.input_key, suggestion);
    }
    return found;
  }
}
