// #56 Reconferir: apaga o que a conferência gravou e roda a captura e a conferência completas de novo.
// Só as tabelas do domínio; nenhuma kit_* (a base do kit é a fonte e fica intacta).
import { tick, type TickSummary } from '../cron/tick.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import type { Env } from '../env.js';

/**
 * #56 As tabelas do domínio, com uma coluna `not null` de cada uma: o PostgREST exige filtro para
 * apagar, e `not.is.null` pega todas. A nota vai primeiro: o `on delete cascade` leva divergências,
 * propostas, aprovações e títulos no mesmo comando, e uma rodada do Cron no meio não deixa filha
 * órfã. As caixas de saída não têm chave para a nota e vão logo depois; as filhas ficam na lista
 * para o caso de uma linha sem nota.
 */
export const DOMAIN_TABLES: readonly (readonly [table: string, column: string])[] = Object.freeze([
  ['invoices', 'access_key'],
  ['outbox_dock_actions', 'id'],
  ['outbox_store_actions', 'id'],
  ['outbox_registry_corrections', 'id'],
  ['outbox_return_notes', 'id'],
  ['approvals', 'id'],
  ['proposals', 'id'],
  ['divergences', 'invoice_access_key'],
  ['titles', 'invoice_access_key'],
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
  runTick: (env: Env) => Promise<TickSummary | null | void> = (e) => tick({ cron: 'reconferir' }, e),
): Promise<TickSummary | null> {
  await resetDomain(rest);
  return (await runTick(env)) ?? null;
}
