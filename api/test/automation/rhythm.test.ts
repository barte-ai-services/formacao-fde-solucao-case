// #356 AC-1 O ritmo da rodada: 1 minuto com o modo demonstração ligado, 15 desligado.
import { describe, expect, it } from 'vitest';
import { roundRhythm } from '../../src/automation/rhythm.js';

const utc = (hhmm: string) => Date.parse(`2026-11-22T${hhmm}:00Z`);

describe('#356/AC-1 roundRhythm', () => {
  it('desligado, só roda quando o minuto UTC é múltiplo de 15', () => {
    expect(roundRhythm(false, utc('10:07')).runs).toBe(false);
    expect(roundRhythm(false, utc('10:14')).runs).toBe(false);
    for (const hhmm of ['10:00', '10:15', '10:30', '10:45']) expect(roundRhythm(false, utc(hhmm)).runs).toBe(true);
  });
  it('ligado, roda em qualquer minuto', () => {
    for (const hhmm of ['10:00', '10:07', '10:14', '10:59']) expect(roundRhythm(true, utc(hhmm)).runs).toBe(true);
  });
  it('o intervalo do modo é 15 minutos desligado e 1 minuto ligado', () => {
    expect(roundRhythm(false, utc('10:15')).intervalMinutes).toBe(15);
    expect(roundRhythm(true, utc('10:07')).intervalMinutes).toBe(1);
  });
  it('o segundo do disparo não muda a decisão do minuto', () => {
    expect(roundRhythm(false, utc('10:15') + 42_000).runs).toBe(true);
    expect(roundRhythm(false, utc('10:07') + 42_000).runs).toBe(false);
  });
});
