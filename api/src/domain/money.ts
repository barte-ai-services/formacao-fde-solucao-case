import { DomainError } from './errors.js';

const BRL = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Dinheiro em BRL, guardado em centavos inteiros. Nunca ponto flutuante. Imutável. */
export class Money {
  private constructor(private readonly value: number) {
    Object.freeze(this);
  }

  /** #59/AC-1: recusa qualquer valor que não seja inteiro seguro. */
  static ofCents(cents: number): Money {
    if (!Number.isSafeInteger(cents)) {
      throw new DomainError(`Money: centavos devem ser inteiros, recebido ${cents}`);
    }
    return new Money(cents);
  }

  /** #59: só para a borda do conector, que entrega reais com casas decimais (8.49 → 849). */
  static fromReais(reais: number): Money {
    return Money.ofCents(Math.round(reais * 100));
  }

  static zero(): Money {
    return new Money(0);
  }

  get cents(): number {
    return this.value;
  }

  add(other: Money): Money {
    return Money.ofCents(this.value + other.value);
  }

  subtract(other: Money): Money {
    return Money.ofCents(this.value - other.value);
  }

  times(k: number): Money {
    if (!Number.isSafeInteger(k)) {
      throw new DomainError(`Money: o fator deve ser inteiro, recebido ${k}`);
    }
    return Money.ofCents(this.value * k);
  }

  compare(other: Money): number {
    return Math.sign(this.value - other.value);
  }

  equals(other: Money): boolean {
    return this.value === other.value;
  }

  isZero(): boolean {
    return this.value === 0;
  }

  isNegative(): boolean {
    return this.value < 0;
  }

  toString(): string {
    const sign = this.value < 0 ? '-' : '';
    return `${sign}R$ ${BRL.format(Math.abs(this.value) / 100)}`;
  }
}
