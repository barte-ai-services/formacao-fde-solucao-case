// #211 O estado da automação e a próxima rodada, puros.
import { describe, expect, it } from 'vitest';
import { automationState, nextRunAt } from '../../src/automation/state.js';

const at = (hhmm: string) => new Date(`2026-11-16T${hhmm}:00Z`);

describe('#211 nextRunAt', () => {
  it('é o próximo múltiplo de 15 minutos depois de agora', () => {
    expect(nextRunAt(at('10:03')).toISOString()).toBe('2026-11-16T10:15:00.000Z');
    expect(nextRunAt(at('10:15')).toISOString()).toBe('2026-11-16T10:30:00.000Z');
    expect(nextRunAt(at('10:59')).toISOString()).toBe('2026-11-16T11:00:00.000Z');
  });
});

describe('#211 automationState', () => {
  const run = (startedAt: string, status: 'ok' | 'failed') => ({ startedAt: at(startedAt).toISOString(), status });

  it('ok quando a última rodada deu certo e é recente', () => {
    expect(automationState(run('10:15', 'ok'), at('10:18'))).toBe('ok');
  });
  it('failed quando a última rodada falhou', () => {
    expect(automationState(run('10:15', 'failed'), at('10:18'))).toBe('failed');
  });
  it('stalled quando faz mais de 2 rodadas que nada roda, mesmo que a última tenha falhado', () => {
    expect(automationState(run('09:45', 'ok'), at('10:29'))).toBe('ok');
    expect(automationState(run('09:45', 'ok'), at('10:31'))).toBe('stalled');
    expect(automationState(run('09:45', 'failed'), at('10:31'))).toBe('stalled');
  });
  it('stalled quando nunca rodou', () => {
    expect(automationState(null, at('10:00'))).toBe('stalled');
  });
});

describe('#356/AC-5 nextRunAt no ritmo do modo', () => { // ADR-002
  it('ligado, é o próximo minuto cheio', () => { // ADR-002
    expect(nextRunAt(at('10:03'), 1).toISOString()).toBe('2026-11-16T10:04:00.000Z');
    expect(nextRunAt(at('10:59'), 1).toISOString()).toBe('2026-11-16T11:00:00.000Z');
  });
  it('sem o intervalo, segue em 15 minutos como hoje', () => { // ADR-002
    expect(nextRunAt(at('10:03')).toISOString()).toBe('2026-11-16T10:15:00.000Z');
  });
});

describe('#356/AC-5 automationState sem falso alarme', () => { // ADR-002
  const run = (startedAt: string, status: 'ok' | 'failed') => ({ startedAt: at(startedAt).toISOString(), status });

  it('com o ritmo de 1 minuto, uma rodada de 3 minutos atrás não é parada', () => { // ADR-002
    expect(automationState(run('10:15', 'ok'), at('10:18'))).toBe('ok');
  });
  it('a medida é a mesma em qualquer modo: 3 intervalos de 15 minutos', () => { // ADR-002
    expect(automationState(run('09:45', 'ok'), at('10:29'))).toBe('ok');
    expect(automationState(run('09:45', 'ok'), at('10:31'))).toBe('stalled');
  });
});
