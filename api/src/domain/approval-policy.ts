import { isAtLeast, maxLevel, type ApprovalLevel } from './approval-level.js';
import type { Classification } from './classification.js';
import type { Supplier } from './context.js';
import type { InvoiceView } from './invoice.js';
import { Money } from './money.js';

/**
 * A régua de aprovação da Já Chegou (`data/kit/regua.json`, `kit_regua`), em centavos.
 * #63: os valores ficam aqui, e não lidos do banco, porque a régua foi validada em 05/11 e muda
 * só com uma decisão nova; o teste confere que estes números são os do kit.
 */
export const REGUA = Object.freeze({
  toleranceAmount: Money.ofCents(5_000), // R$ 50
  /** 0,5%, em pontos-base inteiros para não usar ponto flutuante com dinheiro. */
  tolerancePercentBasisPoints: 50,
  ruleCeiling: Money.ofCents(500_000), // R$ 5 mil
  analystCeiling: Money.ofCents(2_000_000), // R$ 20 mil
  coordinationCeiling: Money.ofCents(10_000_000), // R$ 100 mil
});

/** A linha da régua (docs/domain/README.md, "Limites de aprovação"): vale a primeira que se aplica. */
export type ReguaLine = 1 | 2 | 3 | 4 | 5 | 6;

export type ApprovalRoute = {
  readonly level: ApprovalLevel;
  readonly line: ReguaLine;
  readonly reason: string;
};

const LINE_LEVEL: Readonly<Record<ReguaLine, ApprovalLevel>> = Object.freeze({
  1: 'bloqueio',
  2: 'diretoria',
  3: 'coordenacao',
  4: 'coordenacao',
  5: 'analista',
  6: 'regra',
});

const LINE_REASON: Readonly<Record<ReguaLine, string>> = Object.freeze({
  1: 'Duplicidade (E6): ninguém paga até a coordenação resolver',
  2: 'Nota acima de R$ 100 mil, ou fornecedor com pagamento bloqueado',
  3: 'E5, E8 ou não catalogada, em qualquer valor',
  4: 'E1 a E4 em nota acima de R$ 20 mil',
  5: 'E1 a E4 em nota de até R$ 20 mil',
  6: 'Match exato, E7 (pago fora do fluxo) ou diferença dentro da tolerância',
});

/** Regra 4 e linha 6: até R$ 50 e até 0,5% da nota, em nota de até R$ 5 mil. */
export function withinTolerance(difference: Money, invoiceTotal: Money): boolean {
  if (difference.isNegative()) difference = Money.zero().subtract(difference);
  if (difference.isZero()) return true;
  if (invoiceTotal.compare(REGUA.ruleCeiling) > 0) return false;
  if (difference.compare(REGUA.toleranceAmount) > 0) return false;
  // diferença / total <= 0,5%  ⇔  diferença * 10000 <= total * 50, tudo em centavos inteiros.
  return difference.cents * 10_000 <= invoiceTotal.cents * REGUA.tolerancePercentBasisPoints;
}

/** A linha da régua para uma divergência, olhando só a classificação e o valor da nota. */
function lineForDivergence(classification: Exclude<Classification, 'MATCH'>, total: Money): ReguaLine {
  switch (classification) {
    case 'E6':
      return 1;
    case 'E7':
      return 6; // #177: pago fora do fluxo, como no BPMN: a regra vincula ao pagamento, sem pessoa
    case 'E5':
    case 'E8':
    case 'NAO_CATALOGADA':
      return 3;
    case 'E1':
    case 'E2':
    case 'E3':
    case 'E4':
      return total.compare(REGUA.analystCeiling) > 0 ? 4 : 5;
  }
}

/** A primeira linha da régua que se aplica a um nível: a linha mais alta entre as que dão aquele nível. */
function firstLine(lines: readonly ReguaLine[], level: ApprovalLevel): ReguaLine {
  const match = [...lines].sort((a, b) => a - b).find((l) => LINE_LEVEL[l] === level);
  return match ?? 6;
}

function routeOf(
  invoice: InvoiceView,
  supplier: Pick<Supplier, 'paymentBlocked'> | undefined,
  excluded: Classification | null,
): ApprovalRoute {
  const kept = invoice.divergences.filter((d) => d.classification !== excluded);
  return routeDivergences(kept, invoice.total, supplier);
}

/**
 * A régua como função pura, para qualquer história chamar de fora (decisão do Tech Lead na #63):
 * as classificações das divergências, o valor da nota e o fornecedor dão o nível e a linha.
 * Vale a primeira linha que se aplica; com várias divergências, o maior nível (regra 7). A linha 2
 * (acima de R$ 100 mil ou fornecedor bloqueado) vale qualquer que seja a divergência.
 */
export function routeDivergences(
  divergences: readonly { readonly classification: Exclude<Classification, 'MATCH'> }[],
  invoiceTotal: Money,
  supplier?: Pick<Supplier, 'paymentBlocked'>,
): ApprovalRoute {
  // #177: a nota E7 é compra de emergência já paga, sem ordem (E5) nem cadastro (E8) por natureza; a regra
  // vincula ao pagamento, então esses dois não sobem o nível. E6, a linha 2 e E1 a E4 continuam valendo.
  const paidOutsideFlow = divergences.some((d) => d.classification === 'E7');
  const lines: ReguaLine[] = divergences
    .filter((d) => !(paidOutsideFlow && (d.classification === 'E5' || d.classification === 'E8')))
    .map((d) => lineForDivergence(d.classification, invoiceTotal));
  if (invoiceTotal.compare(REGUA.coordinationCeiling) > 0 || supplier?.paymentBlocked === true) lines.push(2);
  if (lines.length === 0) lines.push(6);
  const level = maxLevel(...lines.map((l) => LINE_LEVEL[l]));
  const line = firstLine(lines, level);
  return Object.freeze({ level, line, reason: LINE_REASON[line] });
}

/**
 * `ApprovalPolicy`: quem aprova a nota, pela régua.
 * Regra 7: o encaminhamento é o maior nível entre todas as divergências (e a linha 2, que vale para a
 * nota inteira). Pode subir, nunca descer: uma divergência a mais nunca baixa o nível.
 */
export const ApprovalPolicy = {
  route(invoice: InvoiceView, supplier?: Pick<Supplier, 'paymentBlocked'>): ApprovalRoute {
    return routeOf(invoice, supplier, null);
  },

  /** O encaminhamento sem uma classificação: o que valeria se ela fosse descartada (decisão 4). */
  routeWithout(
    invoice: InvoiceView,
    excluded: Classification,
    supplier?: Pick<Supplier, 'paymentBlocked'>,
  ): ApprovalRoute {
    return routeOf(invoice, supplier, excluded);
  },


  /** O nível de uma linha da régua. */
  levelOf(line: ReguaLine): ApprovalLevel {
    return LINE_LEVEL[line];
  },

  /** O texto de uma linha da régua, para a tela explicar o encaminhamento. */
  reasonOf(line: ReguaLine): string {
    return LINE_REASON[line];
  },

  /**
   * Decisão 4: o nível bloqueio não é uma pessoa; quem o resolve é a coordenação (AC-10 da #32).
   * Nos demais, a pessoa precisa estar no nível do encaminhamento ou acima (regra 8).
   */
  requiredApproverLevel(level: ApprovalLevel): ApprovalLevel {
    return level === 'bloqueio' ? 'coordenacao' : level;
  },

  /** Regra 8: só quem está no nível exigido, ou acima, aprova. O nível regra não tem pessoa. */
  canApprove(personLevel: PersonLevel | null, routeLevel: ApprovalLevel): boolean {
    if (personLevel === null || routeLevel === 'regra') return false;
    return isAtLeast(personLevel, ApprovalPolicy.requiredApproverLevel(routeLevel));
  },
};

/** O nível de uma pessoa que aprova. Regra e bloqueio não são pessoas. */
export type PersonLevel = Extract<ApprovalLevel, 'analista' | 'coordenacao' | 'diretoria'>;

export const PERSON_LEVELS: readonly PersonLevel[] = Object.freeze(['analista', 'coordenacao', 'diretoria'] as const);

export function isPersonLevel(value: unknown): value is PersonLevel {
  return typeof value === 'string' && (PERSON_LEVELS as readonly string[]).includes(value);
}
