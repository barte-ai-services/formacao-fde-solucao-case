import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import { addBusinessDays, formatBrazilianDate, parseIsoDate } from '../../src/domain/calendar.js';

describe('a leitura da data', () => {
  it('#156 lê AAAA-MM-DD como o dia UTC correspondente', () => {
    expect(parseIsoDate('2026-11-17').toISOString()).toBe('2026-11-17T00:00:00.000Z');
  });

  it('#156 aceita o dia 29 de fevereiro de ano bissexto', () => {
    expect(parseIsoDate('2028-02-29').toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('#156 recusa data que não existe no calendário', () => {
    expect(() => parseIsoDate('2026-02-30')).toThrow(DomainError);
    expect(() => parseIsoDate('2027-02-29')).toThrow(DomainError);
  });

  it('#156 recusa o que não é AAAA-MM-DD', () => {
    for (const raw of ['hoje', '17/11/2026', '2026-1-7', '2026-11-17T10:00:00Z', '']) {
      expect(() => parseIsoDate(raw)).toThrow(DomainError);
    }
  });
});

describe('a data como o e-mail a escreve', () => {
  it('#156 escreve DD/MM/AAAA', () => {
    expect(formatBrazilianDate('2026-11-17')).toBe('17/11/2026');
  });

  it('#156 recusa data inválida', () => {
    expect(() => formatBrazilianDate('2026-02-30')).toThrow(DomainError);
  });
});

describe('a soma de dias úteis', () => {
  it('#156 soma 3 dias úteis pulando o fim de semana', () => {
    expect(addBusinessDays('2026-11-09', 3)).toBe('2026-11-12'); // #156: segunda → quinta
    expect(addBusinessDays('2026-11-12', 3)).toBe('2026-11-17'); // #156: quinta → terça (pula o fim de semana)
  });

  it('#156 um rascunho de sexta, sábado ou domingo vence na quarta', () => {
    for (const day of ['2026-11-13', '2026-11-14', '2026-11-15']) {
      expect(addBusinessDays(day, 3)).toBe('2026-11-18');
    }
  });

  it('#156 atravessa a virada do mês e do ano', () => {
    expect(addBusinessDays('2026-11-27', 3)).toBe('2026-12-02');
    expect(addBusinessDays('2026-12-30', 3)).toBe('2027-01-04');
  });

  it('#156 recusa data que não é AAAA-MM-DD', () => {
    expect(() => addBusinessDays('hoje', 3)).toThrow(DomainError);
    expect(() => addBusinessDays('2026-02-30', 3)).toThrow(DomainError);
  });
});
