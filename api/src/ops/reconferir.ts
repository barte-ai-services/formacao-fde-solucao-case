// #56 Reconferir: apaga o que a conferência gravou e roda a captura e a conferência completas de novo.
// Só as tabelas do domínio; nenhuma kit_* (a base do kit é a fonte e fica intacta).
import { tick } from '../cron/tick.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import type { Env } from '../env.js';

/**
 * #56 As tabelas do domínio, na ordem em que podem ser apagadas (filhas antes da nota), com uma
 * coluna `not null` de cada uma: o PostgREST exige filtro para apagar, e `not.is.null` pega todas.
 */
export const DOMAIN_TABLES: readonly (readonly [table: string, column: string])[] = Object.freeze([
  ['approvals', 'id'],
  ['proposals', 'id'],
  ['divergences', 'invoice_access_key'],
  ['titles', 'invoice_access_key'],
  ['outbox_dock_actions', 'id'],
  ['outbox_registry_corrections', 'id'],
  ['outbox_return_notes', 'id'],
  ['invoices', 'access_key'],
] as const);

/** #56 Apaga as linhas das tabelas do domínio. Recusa qualquer tabela da base do kit. */
export async function resetDomain(rest: SupabaseRest, tables = DOMAIN_TABLES): Promise<void> {
  for (const [table] of tables) {
    if (table.startsWith('kit_')) throw new Error(`reconferir: ${table} é da base do kit e não se apaga`);
  }
  for (const [table, column] of tables) {
    await rest.delete(table, { [column]: 'not.is.null' });
  }
}

/** #56 Apaga e roda o tick uma vez: captura, conferência, conciliação e proposta. */
export async function reconferir(
  rest: SupabaseRest,
  env: Env,
  runTick: (env: Env) => Promise<void> = (e) => tick({ cron: 'reconferir' }, e),
): Promise<void> {
  await resetDomain(rest);
  await runTick(env);
}
