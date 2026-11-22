// #211 O estado da automação e a próxima rodada, puros.
import { describe, expect, it } from 'vitest';
import { automationState, lastExecutedRun, nextRunAt } from '../../src/automation/state.js';

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

describe('#356/AC-5 nextRunAt no ritmo do modo', () => {
  it('ligado, é o próximo minuto cheio', () => {
    expect(nextRunAt(at('10:03'), 1).toISOString()).toBe('2026-11-16T10:04:00.000Z');
    expect(nextRunAt(at('10:59'), 1).toISOString()).toBe('2026-11-16T11:00:00.000Z');
  });
  it('sem o intervalo, segue em 15 minutos como hoje', () => {
    expect(nextRunAt(at('10:03'), 15).toISOString()).toBe('2026-11-16T10:15:00.000Z');
  });
});

describe('#356/AC-5 automationState sem falso alarme', () => {
  const run = (startedAt: string, status: 'ok' | 'failed') => ({ startedAt: at(startedAt).toISOString(), status });

  it('com o ritmo de 1 minuto, uma rodada de 3 minutos atrás não é parada', () => {
    expect(automationState(run('10:15', 'ok'), at('10:18'))).toBe('ok');
  });
  it('a medida é a mesma em qualquer modo: 3 intervalos de 15 minutos', () => {
    expect(automationState(run('09:45', 'ok'), at('10:29'))).toBe('ok');
    expect(automationState(run('09:45', 'ok'), at('10:31'))).toBe('stalled');
  });
});

describe('#356/AC-5 lastExecutedRun ignora as rodadas puladas', () => {
  const row = (startedAt: string, status: 'ok' | 'failed' | 'skipped') => ({ startedAt: at(startedAt).toISOString(), status });

  it('devolve a rodada mais recente que rodou de fato, ok ou failed', () => {
    const newestFirst = [row('10:20', 'skipped'), row('10:19', 'skipped'), row('10:15', 'failed'), row('10:00', 'ok')];
    expect(lastExecutedRun(newestFirst)).toEqual({ startedAt: at('10:15').toISOString(), status: 'failed' });
  });
  it('só puladas ou nenhuma: não há rodada executada', () => {
    expect(lastExecutedRun([row('10:20', 'skipped')])).toBeNull();
    expect(lastExecutedRun([])).toBeNull();
  });
  it('as puladas não escondem a parada: a última executada é a que mede o stalled', () => {
    const last = lastExecutedRun([row('10:40', 'skipped'), row('09:00', 'ok')]);
    expect(automationState(last, at('10:41'))).toBe('stalled');
  });
});
