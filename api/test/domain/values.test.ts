import { describe, expect, it } from 'vitest';
import {
  APPROVAL_LEVELS,
  AmountAtRisk,
  Divergence,
  DockAction,
  Money,
  PRECEDENCE,
  Quantity,
  compareLevels,
  highestPrecedence,
  isAtLeast,
  maxLevel,
} from '../../src/domain/index.js';

describe('Classification', () => {
  it('regra 6: vale a de maior precedência (decisão 1)', () => {
    expect(PRECEDENCE).toEqual(['E6', 'E7', 'E5', 'E8', 'E2', 'E4', 'E1', 'E3', 'NAO_CATALOGADA']);
    expect(highestPrecedence(['E3', 'E1', 'E7'])).toBe('E7');
    expect(highestPrecedence(['NAO_CATALOGADA', 'E4'])).toBe('E4');
  });

  it('regra 4: sem divergência a classificação é MATCH', () => {
    expect(highestPrecedence([])).toBe('MATCH');
    expect(highestPrecedence(['MATCH'])).toBe('MATCH');
  });
});

describe('ApprovalLevel', () => {
  it('regra 7: os níveis vão de regra a bloqueio e o maior vence', () => {
    expect(APPROVAL_LEVELS).toEqual(['regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio']);
    expect(maxLevel('analista', 'diretoria', 'coordenacao')).toBe('diretoria');
    expect(maxLevel()).toBe('regra');
    expect(compareLevels('regra', 'analista')).toBeLessThan(0);
  });

  it('regra 8: aprova quem tem nível igual ou acima', () => {
    expect(isAtLeast('coordenacao', 'analista')).toBe(true);
    expect(isAtLeast('analista', 'analista')).toBe(true);
    expect(isAtLeast('analista', 'coordenacao')).toBe(false);
  });
});

describe('AmountAtRisk', () => {
  const total = Money.ofCents(100000);

  it('regra 3: duplicidade tem valor em risco igual ao valor da nota', () => {
    const risk = AmountAtRisk.full(total);
    expect(risk.amount.equals(total)).toBe(true);
    expect(risk.invoiceTotal.equals(total)).toBe(true);
  });

  it('regra 6: valor em risco fora de [0, total] lança', () => {
    expect(() => AmountAtRisk.of(Money.ofCents(-1), total)).toThrow();
    expect(() => AmountAtRisk.of(Money.ofCents(100001), total)).toThrow();
    expect(AmountAtRisk.of(Money.zero(), total).amount.isZero()).toBe(true);
    expect(AmountAtRisk.of(total, total).amount.equals(total)).toBe(true);
  });
});

describe('Divergence', () => {
  it('regra 6: divergência sem evidência lança', () => {
    expect(() => Divergence.of({ classification: 'E1', skus: ['SKU-1'], evidence: [] })).toThrow();
  });

  it('regra 6: divergência com evidência é imutável', () => {
    const d = Divergence.of({
      classification: 'E1',
      skus: ['SKU-1'],
      evidence: [{ source: 'wms', reference: 'REC-1', description: 'contagem menor' }],
    });
    expect(d.classification).toBe('E1');
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.evidence)).toBe(true);
    expect(Object.isFrozen(d.skus)).toBe(true);
  });
});

describe('DockAction', () => {
  it('receber parcial sem linhas é inválido', () => {
    expect(() => DockAction.partial([])).toThrow();
  });

  it('receber parcial com linhas guarda as linhas', () => {
    const action = DockAction.partial([
      { sku: 'SKU-1', quantity: Quantity.of(2, 'UN'), disposition: 'devolver' },
    ]);
    expect(action.kind).toBe('receber_parcial');
    expect(DockAction.receive().kind).toBe('receber');
    expect(DockAction.refuse().kind).toBe('recusar');
  });
});
