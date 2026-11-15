import { describe, expect, it } from 'vitest';
import { ApprovalPolicy } from '../../src/domain/approval-policy.js';
import { checkNaoCatalogada, priceDifference } from '../../src/domain/checks/nao-catalogada.js';
import { Invoice, Money } from '../../src/domain/index.js';
import { kitContext, kitInvoice, kitSupplier } from './kit.js';

/** NF-036 do kit com o preço de um item trocado, para a diferença sair da tolerância. */
function nf036WithPrice(unitPriceCents: number): Invoice {
  const base = kitInvoice('NF-036');
  const [first, ...rest] = base.items;
  if (!first) throw new Error('NF-036 sem itens');
  const total = Money.ofCents(Math.round(first.quantity.amount * unitPriceCents));
  const items = [{ ...first, unitPrice: Money.ofCents(unitPriceCents), total }, ...rest];
  return Invoice.receive({
    ...base,
    items,
    total: items.reduce((sum, i) => sum.add(i.total), Money.zero()),
  });
}

describe('checkNaoCatalogada (decisão 3, regras 4 e 6)', () => {
  it('AC-1: a NF-036 do kit (R$ 3,84 de diferença em R$ 969,16) fica dentro da tolerância', () => {
    const found = priceDifference(kitInvoice('NF-036'), kitContext());
    expect(found?.difference.cents).toBe(384);
    expect(checkNaoCatalogada(kitInvoice('NF-036'), kitContext())).toEqual([]);
  });

  it('AC-1: a NF-066 do kit (R$ 11,80 em R$ 2.869,80) fica dentro da tolerância', () => {
    expect(checkNaoCatalogada(kitInvoice('NF-066'), kitContext())).toEqual([]);
  });

  it('AC-2: diferença de preço fora da tolerância vira não catalogada, com evidência, e vai à coordenação', () => {
    const invoice = nf036WithPrice(2_000_00);
    const [d] = checkNaoCatalogada(invoice, kitContext());
    expect(d?.classification).toBe('NAO_CATALOGADA');
    expect(d?.evidence.length).toBeGreaterThanOrEqual(2);
    expect(d?.evidence.map((e) => e.source)).toEqual(expect.arrayContaining(['sefaz', 'erp_compras']));

    invoice.check(kitContext(), [{ id: 'NAO_CATALOGADA', run: checkNaoCatalogada }]);
    expect(ApprovalPolicy.route(invoice, kitSupplier(invoice.supplierId))).toMatchObject({
      line: 3,
      level: 'coordenacao',
    });
  });

  it('regra 4: caixa contra unidade (NF-008) não é diferença de preço', () => {
    expect(priceDifference(kitInvoice('NF-008'), kitContext())?.difference.isZero()).toBe(true);
    expect(checkNaoCatalogada(kitInvoice('NF-008'), kitContext())).toEqual([]);
  });

  it('nota sem ordem (NF-029) fica para a E5', () => {
    expect(priceDifference(kitInvoice('NF-029'), kitContext())).toBeNull();
    expect(checkNaoCatalogada(kitInvoice('NF-029'), kitContext())).toEqual([]);
  });

  it('a cobrança a mais é só o que passa da ordem', () => {
    const found = priceDifference(nf036WithPrice(2_000_00), kitContext());
    expect(found && found.overcharge.compare(Money.zero()) > 0).toBe(true);
    expect(found?.overcharge.equals(found.difference)).toBe(true);
  });
});
