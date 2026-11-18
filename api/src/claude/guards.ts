/**
 * Validação na borda do Claude no Worker (#66): toda linha do PostgREST e todo JSON do kit entram
 * como unknown e só viram tipo depois de passar por um guard. Segue api/src/connectors/guards.ts,
 * sem importar de api/ (#66).
 */

export type Guard<T> = (value: unknown) => value is T;

/** #66 Um guard por campo; o satisfies sobre um Shape<T> obriga a cobrir todos os campos. */
export type Shape<T> = { readonly [K in keyof T]-?: Guard<T[K]> };

export const isString: Guard<string> = (v): v is string => typeof v === 'string';
export const isInteger: Guard<number> = (v): v is number => Number.isSafeInteger(v);
/** #66 Instante que o Date entende; o PostgREST devolve timestamptz como texto ISO. */
export const isTimestamp: Guard<string> = (v): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (v): v is T | null => v === null || guard(v);
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

export type Partitioned<T> = { readonly valid: T[]; readonly dropped: number };

/** #66 Separa as linhas que passam no guard das que não passam; as descartadas só são contadas, nunca lidas. */
export function partitionRows<T>(rows: readonly unknown[], guard: Guard<T>): Partitioned<T> {
  const valid = rows.filter(guard);
  return { valid, dropped: rows.length - valid.length };
}
