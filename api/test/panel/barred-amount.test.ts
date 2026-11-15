// Painel do valor barrado no mês (#71, história #39): a soma pura, sem rede.
import { describe, expect, it } from 'vitest';
import {
  BASELINE_CENTS,
  currentMonth,
  monthOf,
  parseMonth,
  summarizeBarredAmount,
  type Month,
  type ProposalRecord,
} from '../../src/panel/barred-amount.js';

const NOV: Month = { year: 2026, month: 11 };

let nextId = 1;
function proposal(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: nextId++,
    classification: 'E1',
    dockActionKind: 'recusar',
    amountAtRiskCents: 10_000,
    state: 'aprovada',
    createdAt: '2026-11-05T12:00:00+00:00',
    approvedAt: '2026-11-05T15:00:00+00:00',
    ...overrides,
  };
}

function barredTotal(records: ProposalRecord[], month: Month = NOV): number {
  return summarizeBarredAmount(records, month).panel.barred.totalCents;
}

describe('#71 valor barrado: o que conta (AC-3)', () => {
  it('#71/AC-3 recusar e receber parcial decididos contam', () => {
    const total = barredTotal([
      proposal({ dockActionKind: 'recusar', amountAtRiskCents: 1_000 }),
      proposal({ dockActionKind: 'receber_parcial', amountAtRiskCents: 250 }),
    ]);
    expect(total).toBe(1_250);
  });

  it('#71/AC-3 receber decidido não conta', () => {
    expect(barredTotal([proposal({ dockActionKind: 'receber', amountAtRiskCents: 9_999 })])).toBe(0);
  });

  it('#71/AC-3 registrada e aguardando aprovação não entram no barrado', () => {
    const total = barredTotal([
      proposal({ state: 'registrada', approvedAt: null }),
      proposal({ state: 'aguardando_aprovacao', approvedAt: null }),
    ]);
    expect(total).toBe(0);
  });

  it('#71/AC-3 alterada conta pela ação vigente: recusar alterada para receber não conta', () => {
    // A ação gravada em dock_action já é a alterada (receber).
    expect(barredTotal([proposal({ state: 'alterada', dockActionKind: 'receber' })])).toBe(0);
  });

  it('#71/AC-3 alterada conta pela ação vigente: receber alterada para recusar conta', () => {
    expect(barredTotal([proposal({ state: 'alterada', dockActionKind: 'recusar', amountAtRiskCents: 777 })])).toBe(777);
  });

  it('#71/AC-3 MATCH com ação que barra é ignorado e registrado', () => {
    const odd = proposal({ classification: 'MATCH', dockActionKind: 'recusar', amountAtRiskCents: 5_000 });
    const waiting = proposal({
      classification: 'MATCH',
      dockActionKind: 'receber_parcial',
      state: 'aguardando_aprovacao',
      approvedAt: null,
    });
    const fine = proposal({ classification: 'MATCH', dockActionKind: 'receber' });
    const result = summarizeBarredAmount([odd, waiting, fine], NOV);
    expect(result.panel.barred.totalCents).toBe(0);
    expect(result.panel.ifApprovedAsProposed.totalCents).toBe(0);
    expect(result.ignoredMatchProposalIds).toEqual([odd.id, waiting.id]);
  });
});

describe('#71 valor barrado: soma por exceção e mês (AC-1)', () => {
  it('#71/AC-1 soma por exceção, na ordem da precedência, só as que têm proposta', () => {
    const result = summarizeBarredAmount(
      [
        proposal({ classification: 'E1', amountAtRiskCents: 100 }),
        proposal({ classification: 'E1', amountAtRiskCents: 200 }),
        proposal({ classification: 'E6', amountAtRiskCents: 1_000 }),
        proposal({ classification: 'NAO_CATALOGADA', amountAtRiskCents: 5 }),
        proposal({ classification: 'E3', dockActionKind: 'receber', amountAtRiskCents: 50 }),
      ],
      NOV,
    );
    expect(result.panel.barred).toEqual({
      totalCents: 1_305,
      byException: [
        { classification: 'E6', cents: 1_000, count: 1 },
        { classification: 'E1', cents: 300, count: 2 },
        { classification: 'NAO_CATALOGADA', cents: 5, count: 1 },
      ],
    });
  });

  it('#71/AC-1 decisão fora do mês não entra', () => {
    const total = barredTotal([
      proposal({ approvedAt: '2026-10-31T12:00:00+00:00', amountAtRiskCents: 1 }),
      proposal({ approvedAt: '2026-12-01T12:00:00+00:00', amountAtRiskCents: 2 }),
      proposal({ approvedAt: '2026-11-30T12:00:00+00:00', amountAtRiskCents: 4 }),
    ]);
    expect(total).toBe(4);
  });

  it('#71/AC-1 borda do fuso: 2026-12-01T02:00Z ainda é novembro em Brasília', () => {
    const late = proposal({ approvedAt: '2026-12-01T02:00:00Z', amountAtRiskCents: 10 });
    const early = proposal({ approvedAt: '2026-11-01T02:59:59Z', amountAtRiskCents: 20 });
    expect(barredTotal([late, early], NOV)).toBe(10);
    expect(barredTotal([early], { year: 2026, month: 10 })).toBe(20);
    expect(barredTotal([late], { year: 2026, month: 12 })).toBe(0);
  });

  it('#71/AC-1 sem linha em approvals (aprovação pela regra), vale a data de criação', () => {
    const total = barredTotal([
      proposal({ approvedAt: null, createdAt: '2026-11-10T10:00:00Z', amountAtRiskCents: 3 }),
      proposal({ approvedAt: null, createdAt: '2026-10-10T10:00:00Z', amountAtRiskCents: 30 }),
    ]);
    expect(total).toBe(3);
  });

  it('#71/AC-1 a data da decisão vence a de criação', () => {
    const created = proposal({ createdAt: '2026-10-30T10:00:00Z', approvedAt: '2026-11-02T10:00:00Z' });
    expect(barredTotal([created], NOV)).toBe(created.amountAtRiskCents);
    expect(barredTotal([created], { year: 2026, month: 10 })).toBe(0);
  });
});

describe('#71 valor barrado: linha de base (AC-2)', () => {
  it('#71/AC-2 a linha de base é R$ 543 mil por mês, sempre', () => {
    expect(BASELINE_CENTS).toBe(54_300_000);
    expect(summarizeBarredAmount([], NOV).panel.baselineCents).toBe(54_300_000);
    expect(summarizeBarredAmount([proposal()], { year: 2027, month: 2 }).panel.baselineCents).toBe(54_300_000);
  });

  it('#71/AC-2 o mês sai como AAAA-MM', () => {
    expect(summarizeBarredAmount([], { year: 2027, month: 2 }).panel.month).toBe('2027-02');
  });
});

describe('#71 barrado se aprovado como proposto (decisão do Tech Lead)', () => {
  it('soma as aguardando com ação que barra, pelo mês de criação, por exceção', () => {
    const result = summarizeBarredAmount(
      [
        proposal({ state: 'aguardando_aprovacao', approvedAt: null, classification: 'E2', amountAtRiskCents: 40 }),
        proposal({
          state: 'aguardando_aprovacao',
          approvedAt: null,
          classification: 'E2',
          dockActionKind: 'receber_parcial',
          amountAtRiskCents: 60,
        }),
        proposal({ state: 'aguardando_aprovacao', approvedAt: null, dockActionKind: 'receber', amountAtRiskCents: 1 }),
        proposal({
          state: 'aguardando_aprovacao',
          approvedAt: null,
          createdAt: '2026-10-20T12:00:00Z',
          amountAtRiskCents: 1_000,
        }),
        proposal({ state: 'registrada', approvedAt: null, amountAtRiskCents: 2_000 }),
      ],
      NOV,
    );
    expect(result.panel.ifApprovedAsProposed).toEqual({
      totalCents: 100,
      byException: [{ classification: 'E2', cents: 100, count: 2 }],
    });
    expect(result.panel.barred.totalCents).toBe(0);
  });
});

describe('#71 acumulado por dia, para o gráfico', () => {
  it('acumula barrado e proposto nos dias com movimento, no fuso de Brasília', () => {
    const result = summarizeBarredAmount(
      [
        proposal({ approvedAt: '2026-11-03T12:00:00Z', amountAtRiskCents: 100 }),
        proposal({ state: 'aguardando_aprovacao', approvedAt: null, createdAt: '2026-11-04T01:00:00Z', amountAtRiskCents: 7 }),
        proposal({ approvedAt: '2026-11-05T12:00:00Z', amountAtRiskCents: 50 }),
        proposal({ approvedAt: '2026-11-05T13:00:00Z', dockActionKind: 'receber', amountAtRiskCents: 999 }),
      ],
      NOV,
    );
    expect(result.panel.daily).toEqual([
      { day: '2026-11-03', barredCumulativeCents: 100, proposedCumulativeCents: 7 },
      { day: '2026-11-05', barredCumulativeCents: 150, proposedCumulativeCents: 7 },
    ]);
  });

  it('sem movimento no mês, a série fica vazia', () => {
    expect(summarizeBarredAmount([], NOV).panel.daily).toEqual([]);
  });
});

describe('#71 mês do parâmetro e mês corrente', () => {
  it('lê AAAA-MM', () => {
    expect(parseMonth('2026-11')).toEqual(NOV);
    expect(parseMonth('2027-01')).toEqual({ year: 2027, month: 1 });
  });

  for (const bad of ['2026-13', '2026-00', '2026-1', '26-11', '2026/11', '2026-11-01', '', ' 2026-11', 'abcd-ef']) {
    it(`recusa o mês malformado ${JSON.stringify(bad)}`, () => {
      expect(parseMonth(bad)).toBeNull();
    });
  }

  it('o mês corrente é o de Brasília', () => {
    expect(currentMonth(new Date('2026-12-01T02:59:59Z'))).toEqual(NOV);
    expect(currentMonth(new Date('2026-12-01T03:00:00Z'))).toEqual({ year: 2026, month: 12 });
  });

  it('o mês de um instante é o de Brasília', () => {
    expect(monthOf('2026-12-01T02:00:00Z')).toEqual(NOV);
    expect(monthOf('2026-11-01T03:00:00.123456+00:00')).toEqual(NOV);
  });
});
