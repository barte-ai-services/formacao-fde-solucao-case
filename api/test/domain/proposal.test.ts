import { describe, expect, it } from 'vitest';
import { AmountAtRisk, DockAction, Money, Proposal, type ApprovalLevel } from '../../src/domain/index.js';

const register = (level: ApprovalLevel) =>
  Proposal.register({
    classification: level === 'regra' ? 'MATCH' : 'E1',
    dockAction: DockAction.receive(),
    level,
    amountAtRisk: AmountAtRisk.of(Money.zero(), Money.ofCents(1000)),
    justification: 'contagem bate',
  });

describe('Proposal', () => {
  it('nasce registrada', () => {
    expect(register('analista').state).toBe('registrada');
  });

  it('regra 8: o match é aprovado pela regra, sem pessoa', () => {
    const p = register('regra');
    p.approveByRule();
    expect(p.state).toBe('aprovada');
  });

  it('regra 8: approveByRule só vale no nível regra', () => {
    expect(() => register('analista').approveByRule()).toThrow();
  });

  it('regra 8: acima de regra aguarda e é aprovada uma vez só', () => {
    const p = register('coordenacao');
    p.awaitApproval();
    expect(p.state).toBe('aguardando_aprovacao');
    p.approve();
    expect(p.state).toBe('aprovada');
    expect(() => p.approve()).toThrow();
    expect(() => p.alter(DockAction.refuse(), 'outra')).toThrow();
  });

  it('regra 8: alterar exige justificativa', () => {
    const p = register('analista');
    p.awaitApproval();
    expect(() => p.alter(DockAction.refuse(), '')).toThrow();
    expect(() => p.alter(DockAction.refuse(), '   ')).toThrow();
    expect(p.dockAction.kind).toBe('receber');
  });

  it('regra 8: alterar grava a nova ação na doca e a justificativa', () => {
    const p = register('analista');
    p.awaitApproval();
    p.alter(DockAction.refuse(), 'fornecedor reenviou a nota');
    expect(p.state).toBe('alterada');
    expect(p.dockAction.kind).toBe('recusar');
    expect(p.justification).toBe('fornecedor reenviou a nota');
  });

  it('transições inválidas lançam', () => {
    const p = register('regra');
    expect(() => p.approve()).toThrow();
    expect(() => p.awaitApproval()).toThrow();
    const q = register('analista');
    q.awaitApproval();
    expect(() => q.awaitApproval()).toThrow();
    expect(() => q.approveByRule()).toThrow();
  });
});
