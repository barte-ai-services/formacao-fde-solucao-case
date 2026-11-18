import { SupabaseRestError } from '../connectors/supabase-rest.js';
import { SupplierStoreError } from './supabase-store.js';

// #157: a falha do PostgREST sai dos adaptadores da leitura só com campos nomeados: a operação, a tabela, o status e o código do
// #157: Postgres. O corpo da resposta (e o que ele diz do banco) fica de fora, e a causa original não é guardada (layer-exposure).

/** #157: o código do Postgres que o PostgREST põe no corpo do erro; o resto do corpo não passa daqui. */
export const pgCode = (detail: string): string | null => /"code"\s*:\s*"(\w{5})"/.exec(detail)?.[1] ?? null;

/** #157: executa uma chamada ao PostgREST; a falha dele vira SupplierStoreError. O erro de formato (`parse`) já é nosso e passa. */
export async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SupabaseRestError && error.operation !== 'parse') {
      throw new SupplierStoreError(error.operation, error.table, error.status, pgCode(error.detail));
    }
    throw error;
  }
}

/** #157: o erro de uma transição que o banco não deixou fazer (a linha não está no estado de partida), sem dado algum. */
export const refused = (operation: string, table: string): SupplierStoreError => new SupplierStoreError(operation, table, 0, null);
