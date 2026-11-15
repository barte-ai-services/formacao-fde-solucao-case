/**
 * O que as tarefas e o laço precisam do banco (#66, #171). Os testes passam um falso; em produção,
 * `restDb` põe o SupabaseRest do Worker por trás dele.
 */
import type { SupabaseRest } from '../connectors/supabase-rest.js';

export type Row = Record<string, unknown>;

export type Filters = Readonly<Record<string, string>>;

export type SelectOptions = {
  readonly select?: string;
  /** #66 Obrigatória: sem ordem explícita o Postgres não garante a mesma sequência entre as páginas. */
  readonly order: string;
  readonly filters?: Filters;
};

export type UpsertOptions = {
  /** #66 Colunas da restrição única que decide a duplicada. */
  readonly onConflict: string;
  /** #66 ignore: a duplicada fica como está; merge: a duplicada é atualizada. */
  readonly resolution: 'ignore' | 'merge';
};

export interface Db {
  select(table: string, options: SelectOptions): Promise<unknown[]>;
  upsert(table: string, rows: readonly Row[], options: UpsertOptions): Promise<unknown[]>;
}

/** #171 O Db sobre o SupabaseRest: a linha nova entra ignorando a duplicada, a refeita faz merge. */
export function restDb(rest: SupabaseRest): Db {
  return {
    select: (table, options) => rest.select(table, options),
    upsert: (table, rows, options) =>
      options.resolution === 'merge'
        ? rest.upsert(table, rows, options.onConflict)
        : rest.insert(table, rows, { onConflict: options.onConflict, ignoreDuplicates: true }),
  };
}
