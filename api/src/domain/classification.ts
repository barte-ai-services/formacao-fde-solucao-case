export type ExceptionCode = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8';

export type Classification = 'MATCH' | ExceptionCode | 'NAO_CATALOGADA';

/** Decisão 1: precedência entre as exceções, da maior para a menor. */
export const PRECEDENCE: readonly Classification[] = Object.freeze([
  'E6',
  'E7',
  'E5',
  'E8',
  'E2',
  'E4',
  'E1',
  'E3',
  'NAO_CATALOGADA',
] as const);

/** Regra 6: com várias divergências, vale a de maior precedência. Sem nenhuma, é MATCH. */
export function highestPrecedence(cs: readonly Classification[]): Classification {
  for (const candidate of PRECEDENCE) {
    if (cs.includes(candidate)) return candidate;
  }
  return 'MATCH';
}
