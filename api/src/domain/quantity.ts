import { DomainError } from './errors.js';

export type Unit = 'UN' | 'CX';

/** AC-1: quantidades só se comparam na mesma unidade. */
export class UnitMismatchError extends DomainError {
  constructor(a: Unit, b: Unit) {
    super(`Quantity: unidades diferentes (${a} e ${b}); converta antes de comparar`);
    this.name = 'UnitMismatchError';
  }
}

/** Número e unidade. Imutável. */
export class Quantity {
  private constructor(
    readonly amount: number,
    readonly unit: Unit,
  ) {
    Object.freeze(this);
  }

  static of(amount: number, unit: Unit): Quantity {
    if (!Number.isFinite(amount)) {
      throw new DomainError(`Quantity: quantidade inválida ${amount}`);
    }
    return new Quantity(amount, unit);
  }

  compare(other: Quantity): number {
    this.assertSameUnit(other);
    return Math.sign(this.amount - other.amount);
  }

  equals(other: Quantity): boolean {
    return this.compare(other) === 0;
  }

  isLessThan(other: Quantity): boolean {
    return this.compare(other) < 0;
  }

  subtract(other: Quantity): Quantity {
    this.assertSameUnit(other);
    return new Quantity(this.amount - other.amount, this.unit);
  }

  /** Regra 4, #59: caixa vira unidade pelo fator do produto (12 CX, fator 4 = 48 UN). UN fica igual. */
  toUnits(boxFactor: number): Quantity {
    if (!Number.isSafeInteger(boxFactor) || boxFactor <= 0) {
      throw new DomainError(`Quantity: fator de caixa deve ser inteiro > 0, recebido ${boxFactor}`);
    }
    return this.unit === 'UN' ? this : new Quantity(this.amount * boxFactor, 'UN');
  }

  private assertSameUnit(other: Quantity): void {
    if (this.unit !== other.unit) throw new UnitMismatchError(this.unit, other.unit);
  }
}
