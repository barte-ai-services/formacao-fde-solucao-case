import { describe, expect, it } from 'vitest';
import { ApprovalPolicy, REGUA, routeDivergences, withinTolerance } from '../../src/domain/approval-policy.js';
import { checkNaoCatalogada } from '../../src/domain/checks/nao-catalogada.js';
import { Money } from '../../src/domain/index.js';
import { checkedWith, kitContext, kitInvoice, kitRegua, kitSupplier } from './kit.js';

const route = (notaId: string, ...cs: Parameters<typeof checkedWith>[1][]) => {
  const invoice = checkedWith(kitInvoice(notaId), ...cs);
  return ApprovalPolicy.route(invoice, kitSupplier(invoice.supplierId));
};

describe('a régua é a do kit', () => {
  it('#63: os tetos e a tolerância batem com data/kit/regua.json', () => {
    const r = kitRegua();
    expect(REGUA.toleranceAmount.equals(Money.fromReais(r.tolerancia_valor))).toBe(true);
    expect(REGUA.tolerancePercentBasisPoints / 10_000).toBe(r.tolerancia_percentual);
    expect(REGUA.ruleCeiling.equals(Money.fromReais(r.teto_regra_tolerancia))).toBe(true);
    expect(REGUA.analystCeiling.equals(Money.fromReais(r.teto_analista))).toBe(true);
    expect(REGUA.coordinationCeiling.equals(Money.fromReais(r.teto_coordenacao))).toBe(true);
    expect(r.niveis).toEqual(['regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio']);
  });
});

describe('AC-3: cada linha da régua tem um caso da base do kit', () => {
  it('linha 1: duplicidade (NF-012 cobra a OC-2026-42812, já lançada) vai a bloqueio', () => {
    expect(route('NF-012', 'E6')).toMatchObject({ line: 1, level: 'bloqueio' });
  });

  it('linha 2: nota acima de R$ 100 mil (NF-003, R$ 132.747,60) vai à diretoria', () => {
    expect(route('NF-003')).toMatchObject({ line: 2, level: 'diretoria' });
  });

  it('linha 2: fornecedor com pagamento bloqueado (NF-080, F12) vai à diretoria', () => {
    expect(kitSupplier('F12')?.paymentBlocked).toBe(true);
    expect(route('NF-080')).toMatchObject({ line: 2, level: 'diretoria' });
  });

  it('linha 3: nota sem ordem (NF-029, E5) vai à coordenação', () => {
    expect(kitInvoice('NF-029').purchaseOrderRef).toBeNull();
    expect(route('NF-029', 'E5')).toMatchObject({ line: 3, level: 'coordenacao' });
  });

  it('linha 4: E4 em nota acima de R$ 20 mil (NF-044, R$ 53.685,32) vai à coordenação', () => {
    expect(route('NF-044', 'E4')).toMatchObject({ line: 4, level: 'coordenacao' });
  });

  it('linha 5: E4 em nota de até R$ 20 mil (NF-008, R$ 9.463,36) vai ao analista', () => {
    expect(route('NF-008', 'E4')).toMatchObject({ line: 5, level: 'analista' });
  });

  it('linha 6: diferença dentro da tolerância (NF-036, R$ 3,84 em R$ 969,16) vai à regra', () => {
    const invoice = kitInvoice('NF-036');
    invoice.check(kitContext(), [{ id: 'NAO_CATALOGADA', run: checkNaoCatalogada }]);
    expect(invoice.classification).toBe('MATCH');
    expect(ApprovalPolicy.route(invoice, kitSupplier(invoice.supplierId))).toMatchObject({ line: 6, level: 'regra' });
  });
});

describe('AC-1 e AC-2: a tolerância da linha 6', () => {
  const total = Money.ofCents(500_000);
  it('AC-1: match exato está dentro', () => {
    expect(withinTolerance(Money.zero(), Money.ofCents(50_000_000))).toBe(true);
  });
  it('AC-1: até R$ 50 e até 0,5% em nota de até R$ 5 mil está dentro', () => {
    expect(withinTolerance(Money.ofCents(2_500), total)).toBe(true); // 0,5% de R$ 5 mil = R$ 25
  });
  it('AC-2: passa de 0,5% está fora', () => {
    expect(withinTolerance(Money.ofCents(2_501), total)).toBe(false);
  });
  it('AC-2: passa de R$ 50 está fora, mesmo abaixo de 0,5%', () => {
    expect(withinTolerance(Money.ofCents(5_001), Money.ofCents(500_000))).toBe(false);
  });
  it('AC-2: nota acima de R$ 5 mil não tem tolerância', () => {
    expect(withinTolerance(Money.ofCents(1), Money.ofCents(500_001))).toBe(false);
  });
  it('a diferença para baixo conta igual', () => {
    expect(withinTolerance(Money.ofCents(-2_501), total)).toBe(false);
  });
});

describe('AC-4: diretoria qualquer que seja a divergência', () => {
  it('nota acima de R$ 100 mil com E4 vai à diretoria, não à coordenação', () => {
    expect(route('NF-039', 'E4')).toMatchObject({ line: 2, level: 'diretoria' });
  });
  it('fornecedor bloqueado com E5 vai à diretoria', () => {
    expect(route('NF-080', 'E5')).toMatchObject({ line: 2, level: 'diretoria' });
  });
  it('a duplicidade ainda fica acima da diretoria (linha 1)', () => {
    expect(route('NF-003', 'E6')).toMatchObject({ line: 1, level: 'bloqueio' });
  });
});

describe('AC-5, regra 7: o maior nível entre as divergências, que nunca desce', () => {
  it('E4 (analista) com não catalogada (coordenação) vai à coordenação', () => {
    expect(route('NF-008', 'E4', 'NAO_CATALOGADA')).toMatchObject({ line: 3, level: 'coordenacao' });
  });
  it('uma divergência de nível menor não baixa o encaminhamento', () => {
    const alone = route('NF-029', 'E5').level;
    const withLower = route('NF-029', 'E5', 'E1').level;
    expect(withLower).toBe(alone);
  });
  it('a ordem das divergências não muda o encaminhamento', () => {
    expect(route('NF-008', 'NAO_CATALOGADA', 'E4')).toEqual(route('NF-008', 'E4', 'NAO_CATALOGADA'));
  });
});

describe('regra 8 e decisão 4: quem pode aprovar', () => {
  it('no nível bloqueio, a coordenação resolve (AC-10)', () => {
    expect(ApprovalPolicy.requiredApproverLevel('bloqueio')).toBe('coordenacao');
    expect(ApprovalPolicy.canApprove('coordenacao', 'bloqueio')).toBe(true);
    expect(ApprovalPolicy.canApprove('analista', 'bloqueio')).toBe(false);
  });
  it('AC-7: abaixo do nível não aprova; no nível ou acima, aprova', () => {
    expect(ApprovalPolicy.canApprove('analista', 'coordenacao')).toBe(false);
    expect(ApprovalPolicy.canApprove('coordenacao', 'coordenacao')).toBe(true);
    expect(ApprovalPolicy.canApprove('diretoria', 'analista')).toBe(true);
  });
  it('no nível regra não há pessoa, e quem não tem nível não aprova', () => {
    expect(ApprovalPolicy.canApprove('diretoria', 'regra')).toBe(false);
    expect(ApprovalPolicy.canApprove(null, 'analista')).toBe(false);
  });
});

describe('routeDivergences: a régua como função pura, para as outras histórias', () => {
  const total = (reais: number) => Money.fromReais(reais);
  it('as seis linhas, na ordem', () => {
    expect(routeDivergences([{ classification: 'E6' }], total(1000))).toMatchObject({ line: 1, level: 'bloqueio' });
    expect(routeDivergences([], total(100_000.01))).toMatchObject({ line: 2, level: 'diretoria' });
    expect(routeDivergences([{ classification: 'E1' }], total(10), { paymentBlocked: true })).toMatchObject({ line: 2, level: 'diretoria' });
    expect(routeDivergences([{ classification: 'E7' }], total(10))).toMatchObject({ line: 6, level: 'regra' });
    expect(routeDivergences([{ classification: 'E3' }], total(20_000.01))).toMatchObject({ line: 4, level: 'coordenacao' });
    expect(routeDivergences([{ classification: 'E3' }], total(20_000))).toMatchObject({ line: 5, level: 'analista' });
    expect(routeDivergences([], total(5_000))).toMatchObject({ line: 6, level: 'regra' });
  });
  it('#177: o E7 absorve E5 e E8 (consequências da compra de emergência), mas não E6 nem a linha 2', () => {
    expect(routeDivergences([{ classification: 'E7' }, { classification: 'E5' }, { classification: 'E8' }], total(3000))).toMatchObject({ line: 6, level: 'regra' });
    expect(routeDivergences([{ classification: 'E7' }, { classification: 'E6' }], total(3000))).toMatchObject({ line: 1, level: 'bloqueio' });
    expect(routeDivergences([{ classification: 'E7' }, { classification: 'E5' }], total(100_000.01))).toMatchObject({ line: 2, level: 'diretoria' });
    expect(routeDivergences([{ classification: 'E7' }, { classification: 'E3' }], total(30_000))).toMatchObject({ line: 4, level: 'coordenacao' });
  });
  it('dá o mesmo que ApprovalPolicy.route para a nota', () => {
    const invoice = checkedWith(kitInvoice('NF-008'), 'E4', 'E5');
    expect(routeDivergences(invoice.divergences, invoice.total)).toEqual(ApprovalPolicy.route(invoice));
  });
});
