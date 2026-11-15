// Validação na borda, sem dependência (#59): toda linha que chega de fora passa por um guard antes de virar tipo.
import { SupabaseRestError } from './supabase-rest.js';

export type Guard<T> = (value: unknown) => value is T;

/** #59 Um guard por campo; o satisfies sobre um Shape<T> obriga a cobrir todos os campos com o tipo certo. */
export type Shape<T> = { readonly [K in keyof T]-?: Guard<T[K]> };

export const isString: Guard<string> = (v): v is string => typeof v === 'string';
export const isNumber: Guard<number> = (v): v is number => typeof v === 'number' && Number.isFinite(v);
export const isInteger: Guard<number> = (v): v is number => Number.isSafeInteger(v);
export const isBoolean: Guard<boolean> = (v): v is boolean => typeof v === 'boolean';
export const isUnknown: Guard<unknown> = (_v): _v is unknown => true;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (v): v is T | null => v === null || guard(v);
}

export function optional<T>(guard: Guard<T>): Guard<T | undefined> {
  return (v): v is T | undefined => v === undefined || guard(v);
}

export function oneOf<const T extends string>(...values: readonly T[]): Guard<T> {
  return (v): v is T => typeof v === 'string' && values.some((x) => x === v);
}

export function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (v): v is T[] => Array.isArray(v) && v.every(guard);
}

export function shaped<T>(shape: Shape<T>): Guard<T> {
  return (v): v is T => {
    if (!isRecord(v)) return false;
    const checks: Record<string, Guard<unknown>> = shape;
    return Object.entries(checks).every(([key, check]) => check(v[key]));
  };
}

/** #59 Valida as linhas; a primeira inválida vira erro com a tabela e o índice, nunca os dados. */
export function parseRows<T>(rows: readonly unknown[], guard: Guard<T>, table: string): T[] {
  return rows.map((row, index) => parseOne(row, guard, table, index));
}

export function parseOne<T>(row: unknown, guard: Guard<T>, table: string, index = 0): T {
  if (!guard(row)) throw new SupabaseRestError('parse', table, 0, `linha ${index} fora do formato esperado`);
  return row;
}
