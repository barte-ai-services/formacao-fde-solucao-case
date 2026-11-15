// #211 AC-5 Os indicadores: % resolvido sem pessoa e tempo mediano da captura à decisão.
import { describe, expect, it } from 'vitest';
import { computeIndicators } from '../../src/automation/indicators.js';

const NOW = new Date('2026-11-16T15:00:00Z'); // 12h em Brasília

describe('#211 computeIndicators', () => {
  it('conta o dia e o mês, em Brasília, e a mediana separa sem pessoa de com pessoa', () => {
    const r = computeIndicators(
      [
        { capturedAt: '2026-11-16T13:00:00Z', decidedAt: '2026-11-16T13:00:00Z', by: 'rule' },
        { capturedAt: '2026-11-16T13:00:00Z', decidedAt: '2026-11-16T13:10:00Z', by: 'rule' },
        { capturedAt: '2026-11-16T13:00:00Z', decidedAt: '2026-11-16T14:00:00Z', by: 'person' },
        { capturedAt: '2026-11-03T13:00:00Z', decidedAt: '2026-11-03T15:00:00Z', by: 'person' },
        { capturedAt: '2026-10-30T13:00:00Z', decidedAt: '2026-10-30T15:00:00Z', by: 'person' },
        // 01h UTC de 17/11 ainda é 16/11 22h em Brasília
        { capturedAt: '2026-11-17T01:00:00Z', decidedAt: '2026-11-17T01:30:00Z', by: 'rule' },
      ],
      NOW,
    );
    expect(r.day).toEqual({
      date: '2026-11-16', decided: 4, byRule: 3, byEngine: 0, withoutPersonPct: 75,
      medianSeconds: { withoutPerson: 600, withPerson: 3600 },
    });
    expect(r.month).toMatchObject({ month: '2026-11', decided: 5, byRule: 3, withoutPersonPct: 60 });
  });
  it('#42 o motor conta como sem pessoa, em byEngine, e fica fora de byRule e da mediana com pessoa', () => {
    const r = computeIndicators(
      [
        { capturedAt: '2026-11-16T13:00:00Z', decidedAt: '2026-11-16T13:01:00Z', by: 'rule' },
        { capturedAt: '2026-11-16T13:00:00Z', decidedAt: '2026-11-16T13:03:00Z', by: 'engine' },
        { capturedAt: '2026-11-16T13:00:00Z', decidedAt: '2026-11-16T13:05:00Z', by: 'engine' },
        { capturedAt: '2026-11-16T13:00:00Z', decidedAt: '2026-11-16T14:00:00Z', by: 'person' },
      ],
      NOW,
    );
    expect(r.day).toEqual({
      date: '2026-11-16', decided: 4, byRule: 1, byEngine: 2, withoutPersonPct: 75,
      medianSeconds: { withoutPerson: 180, withPerson: 3600 },
    });
  });
  it('sem decisão, tudo nulo', () => {
    expect(computeIndicators([], NOW).day).toEqual({
      date: '2026-11-16', decided: 0, byRule: 0, byEngine: 0, withoutPersonPct: null,
      medianSeconds: { withoutPerson: null, withPerson: null },
    });
  });
});
