// #66 Sugestões do Claude na tabela claude_suggestions. O Cron as grava (api/src/claude, #171); aqui o Worker
// lê o que ficou gravado, e a regra confirma (description-match.ts).
import type { DescriptionSuggester } from '../domain/description-match.js';
import { isString, nullable, parseRows, shaped, type Shape } from './guards.js';
import type { SupabaseRest } from './supabase-rest.js';

const TABLE = 'claude_suggestions';
const TASK = 'description-match';

/** #66 Uma linha ok da tarefa description-match: a chave e o candidato que o Claude escolheu. */
export type DescriptionSuggestionRow = {
  readonly input_key: string;
  readonly output: { readonly match: string | null };
};

const isOutput = shaped<DescriptionSuggestionRow['output']>({ match: nullable(isString) });
const isRow = shaped<DescriptionSuggestionRow>({
  input_key: isString,
  output: isOutput,
} satisfies Shape<DescriptionSuggestionRow>);

/**
 * #66 A chave de um pedido de casamento: sha256 hex de `descrição + "\n" + candidatos ordenados`,
 * com os candidatos ordenados por localeCompare em pt-BR, para não depender da ordem do cadastro.
 * É a chave que src/claude/tasks/description-match.ts usa para gravar: ela importa esta função.
 */
export async function descriptionMatchKey(description: string, candidates: readonly string[]): Promise<string> {
  const sorted = [...candidates].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const text = `${description}\n${sorted.join('\n')}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** #66 Lê as sugestões ok da tarefa description-match, só a chave e a saída, conferidas pelo guard. */
export async function listDescriptionSuggestions(rest: SupabaseRest): Promise<DescriptionSuggestionRow[]> {
  const rows = await rest.select(TABLE, {
    select: 'input_key,output',
    filters: { task: `eq.${TASK}`, status: 'eq.ok' },
  });
  return parseRows(rows, isRow, TABLE);
}

/**
 * #66 O sugestor que responde com o que a rodada gravou: o índice do candidato escolhido, na ordem
 * original dos candidatos. Sem linha para a chave, ou com um match que não é um dos candidatos, null.
 */
export function storedDescriptionSuggester(rows: readonly DescriptionSuggestionRow[]): DescriptionSuggester {
  const byKey = new Map(rows.map((r) => [r.input_key, r.output.match]));
  return {
    async suggest(description, candidates) {
      const match = byKey.get(await descriptionMatchKey(description, candidates));
      if (match === undefined || match === null) return null;
      const index = candidates.indexOf(match);
      return index >= 0 ? index : null;
    },
  };
}
