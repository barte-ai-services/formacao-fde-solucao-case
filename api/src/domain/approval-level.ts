export type ApprovalLevel = 'regra' | 'analista' | 'coordenacao' | 'diretoria' | 'bloqueio';

/** Em ordem crescente: regra < analista < coordenação < diretoria < bloqueio. */
export const APPROVAL_LEVELS: readonly ApprovalLevel[] = Object.freeze([
  'regra',
  'analista',
  'coordenacao',
  'diretoria',
  'bloqueio',
] as const);

export function compareLevels(a: ApprovalLevel, b: ApprovalLevel): number {
  return Math.sign(APPROVAL_LEVELS.indexOf(a) - APPROVAL_LEVELS.indexOf(b));
}

/** Regra 7: o encaminhamento é o maior nível entre todas as divergências. Sem nenhuma, regra. */
export function maxLevel(...levels: readonly ApprovalLevel[]): ApprovalLevel {
  return levels.reduce<ApprovalLevel>((max, l) => (compareLevels(l, max) > 0 ? l : max), 'regra');
}

/** Regra 8: `a` está no nível `b` ou acima. */
export function isAtLeast(a: ApprovalLevel, b: ApprovalLevel): boolean {
  return compareLevels(a, b) >= 0;
}
