import { describe, expect, it } from 'vitest';
import { checkNotaSemOrdem } from '../../src/domain/checks/e5-nota-sem-ordem.js';
import { Money } from '../../src/domain/index.js';
import { routeDivergences } from '../../src/domain/approval-policy.js';
import { emptyContext } from './fixtures.js';
import { invoiceWith, item, KEY, order } from './e5-fixtures.js';

describe('E5 — nota sem ordem (#34)', () => {
  it('#34/AC-1: nota sem referência de ordem gera uma divergência E5', () => {
    const result = checkNotaSemOrdem(invoiceWith(null), emptyContext({ purchaseOrders: [order('OC-1')] }));
    expect(result).toHaveLength(1);
    expect(result[0]?.classification).toBe('E5');
  });

  it('#34/AC-1: referência em branco conta como nota sem ordem', () => {
    const result = checkNotaSemOrdem(invoiceWith('   '), emptyContext());
    expect(result.map((d) => d.classification)).toEqual(['E5']);
  });

  it('#34/AC-1: nota que cita uma ordem que Compras não tem gera E5', () => {
    const result = checkNotaSemOrdem(invoiceWith('OC-404'), emptyContext({ purchaseOrders: [order('OC-1')] }));
    expect(result.map((d) => d.classification)).toEqual(['E5']);
  });

  it('#34/AC-1: nota cuja ordem existe não é E5', () => {
    expect(checkNotaSemOrdem(invoiceWith('OC-1'), emptyContext({ purchaseOrders: [order('OC-1')] }))).toEqual([]);
  });

  it('#34/AC-1, regra 6: a divergência cita a nota na SEFAZ e a ausência em Compras', () => {
    const [sem] = checkNotaSemOrdem(invoiceWith(null), emptyContext());
    expect(sem?.evidence.map((e) => e.source)).toEqual(['sefaz', 'erp_compras']);
    expect(sem?.evidence[0]?.reference).toBe(KEY);
    expect(sem?.evidence[1]?.reference).toBe('sem referência');

    const [citada] = checkNotaSemOrdem(invoiceWith('OC-404'), emptyContext());
    expect(citada?.evidence[0]?.description).toContain('OC-404');
    expect(citada?.evidence[1]?.reference).toBe('OC-404');
  });

  it('#34/AC-1: a divergência lista os SKUs não nulos da nota', () => {
    const inv = invoiceWith(null, [item('A1', 1), item('Z9', 1, 'UN', 'Sem cadastro', null)]);
    expect(checkNotaSemOrdem(inv, emptyContext())[0]?.skus).toEqual(['SKU-A1']);
  });

  it('#34/AC-4: E5 vai para a coordenação pela régua (routeDivergences, linha 3)', () => {
    const divergences = checkNotaSemOrdem(invoiceWith(null), emptyContext());
    const route = routeDivergences(divergences, Money.ofCents(100_000));
    expect(route.level).toBe('coordenacao');
    expect(route.line).toBe(3);
  });
});
