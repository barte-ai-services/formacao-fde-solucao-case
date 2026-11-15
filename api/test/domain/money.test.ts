import { describe, expect, it } from 'vitest';
import { Money } from '../../src/domain/index.js';

describe('Money', () => {
  it('AC-1: recusa ponto flutuante em centavos', () => {
    expect(() => Money.ofCents(1.5)).toThrow();
    expect(() => Money.ofCents(Number.NaN)).toThrow();
  });

  it('AC-1: converte reais da borda do conector para centavos inteiros', () => {
    expect(Money.fromReais(8.49).cents).toBe(849);
    expect(Money.fromReais(0.1 + 0.2).cents).toBe(30);
  });

  it('AC-1: soma, subtrai e multiplica em centavos inteiros', () => {
    const a = Money.ofCents(849);
    expect(a.add(Money.ofCents(151)).cents).toBe(1000);
    expect(a.subtract(Money.ofCents(900)).isNegative()).toBe(true);
    expect(a.times(3).cents).toBe(2547);
    expect(() => a.times(1.5)).toThrow();
  });

  it('AC-1: é imutável e compara por valor', () => {
    const a = Money.ofCents(100);
    a.add(Money.ofCents(1));
    expect(a.cents).toBe(100);
    expect(a.equals(Money.ofCents(100))).toBe(true);
    expect(a.compare(Money.ofCents(200))).toBeLessThan(0);
    expect(Money.zero().isZero()).toBe(true);
  });

  it('AC-1: formata em reais', () => {
    expect(Money.ofCents(123456).toString()).toBe('R$ 1.234,56');
    expect(Money.ofCents(5).toString()).toBe('R$ 0,05');
    expect(Money.ofCents(-123456).toString()).toBe('-R$ 1.234,56');
  });
});
