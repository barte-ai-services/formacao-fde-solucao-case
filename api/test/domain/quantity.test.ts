import { describe, expect, it } from 'vitest';
import { Quantity, UnitMismatchError } from '../../src/domain/index.js';

describe('Quantity', () => {
  it('AC-1: comparar UN com CX lança UnitMismatchError', () => {
    const un = Quantity.of(48, 'UN');
    const cx = Quantity.of(12, 'CX');
    expect(() => un.compare(cx)).toThrow(UnitMismatchError);
    expect(() => un.equals(cx)).toThrow(UnitMismatchError);
    expect(() => un.isLessThan(cx)).toThrow(UnitMismatchError);
    expect(() => un.subtract(cx)).toThrow(UnitMismatchError);
  });

  it('regra 4: 12 CX com fator 4 viram 48 UN e comparam igual a 48 UN', () => {
    const converted = Quantity.of(12, 'CX').toUnits(4);
    expect(converted.amount).toBe(48);
    expect(converted.unit).toBe('UN');
    expect(converted.equals(Quantity.of(48, 'UN'))).toBe(true);
  });

  it('regra 4: UN fica igual na conversão e fator inválido lança', () => {
    expect(Quantity.of(7, 'UN').toUnits(4).amount).toBe(7);
    expect(() => Quantity.of(1, 'CX').toUnits(0)).toThrow();
    expect(() => Quantity.of(1, 'CX').toUnits(2.5)).toThrow();
  });

  it('AC-1: subtrai e compara na mesma unidade', () => {
    const q = Quantity.of(10, 'UN').subtract(Quantity.of(3, 'UN'));
    expect(q.amount).toBe(7);
    expect(Quantity.of(3, 'UN').isLessThan(Quantity.of(10, 'UN'))).toBe(true);
  });
});
