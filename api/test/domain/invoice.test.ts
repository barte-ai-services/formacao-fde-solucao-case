import { describe, expect, it } from 'vitest';
import { CHECKS, Divergence, type Check, type NamedCheck } from '../../src/domain/index.js';
import { anInvoice, emptyContext } from './fixtures.js';
import { order } from './e5-fixtures.js';

type CheckId = NamedCheck['id'];

const ORDER: CheckId[] = ['E6', 'E7', 'E5', 'E8', 'E2', 'E4', 'E1', 'E3', 'NAO_CATALOGADA'];

const evidence = [{ source: 'erp_contas_a_pagar' as const, reference: 'T-1', description: 'já lançada' }];

const spies = (calls: CheckId[], results: Partial<Record<CheckId, Check>> = {}): NamedCheck[] =>
  ORDER.map((id) => ({
    id,
    run: (invoice, ctx) => {
      calls.push(id);
      return results[id]?.(invoice, ctx) ?? [];
    },
  }));

describe('Invoice', () => {
  it('regra 1: a nota é única pela chave de acesso', () => {
    expect(anInvoice('K1').equals(anInvoice('K1'))).toBe(true);
    expect(anInvoice('K1').equals(anInvoice('K2'))).toBe(false);
  });

  it('nasce a conferir, sem divergências', () => {
    const invoice = anInvoice();
    expect(invoice.state).toBe('a_conferir');
    expect(invoice.divergences).toEqual([]);
    expect(invoice.classification).toBe('MATCH');
  });

  it('AC-2: check() chama as verificações na ordem E6, E7, E5, E8, E2, E4, E1, E3, NAO_CATALOGADA', () => {
    const calls: CheckId[] = [];
    anInvoice().check(emptyContext(), spies(calls));
    expect(calls).toEqual(ORDER);
  });

  it('AC-2 regra 2: com E6 achando duplicidade, só E6 roda e a nota fica conferida como E6', () => {
    const calls: CheckId[] = [];
    const invoice = anInvoice();
    invoice.check(
      emptyContext(),
      spies(calls, { E6: () => [Divergence.of({ classification: 'E6', skus: [], evidence })] }),
    );
    expect(calls).toEqual(['E6']);
    expect(invoice.state).toBe('conferida');
    expect(invoice.classification).toBe('E6');
  });

  it('AC-2 regra 6: junta as divergências e vale a de maior precedência', () => {
    const invoice = anInvoice();
    invoice.check(
      emptyContext(),
      spies([], {
        E3: () => [Divergence.of({ classification: 'E3', skus: ['SKU-1'], evidence })],
        E2: () => [Divergence.of({ classification: 'E2', skus: ['SKU-1'], evidence })],
      }),
    );
    expect(invoice.divergences.map((d) => d.classification)).toEqual(['E2', 'E3']);
    expect(invoice.classification).toBe('E2');
  });

  it('AC-2: CHECKS real tem os ids na ordem da regra 2', () => {
    expect(CHECKS.map((c) => c.id)).toEqual(ORDER);
  });

  it('AC-2: com as verificações vazias, toda nota sai MATCH', () => {
    const invoice = anInvoice();
    // #65: a E5 já está preenchida; a ordem que a nota cita existe em Compras, então ela não acusa.
    invoice.check(emptyContext({ purchaseOrders: [order('OC-100')] }));
    expect(invoice.state).toBe('conferida');
    expect(invoice.classification).toBe('MATCH');
  });

  it('AC-2 regra 2: check fora de a_conferir lança', () => {
    const invoice = anInvoice();
    invoice.check(emptyContext());
    expect(() => invoice.check(emptyContext())).toThrow();
  });

  it('transições: conferida → com_proposta → decidida; inválidas lançam', () => {
    const invoice = anInvoice();
    expect(() => invoice.markProposed()).toThrow();
    expect(() => invoice.markDecided()).toThrow();
    invoice.check(emptyContext());
    expect(() => invoice.markDecided()).toThrow();
    invoice.markProposed();
    expect(invoice.state).toBe('com_proposta');
    expect(() => invoice.markProposed()).toThrow();
    invoice.markDecided();
    expect(invoice.state).toBe('decidida');
    expect(() => invoice.markDecided()).toThrow();
  });
});
