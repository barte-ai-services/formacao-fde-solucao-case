/** Testes dos guards da borda do Claude no Worker (#66). */
import { describe, expect, it } from 'vitest';
import { arrayOf, isInteger, isRecord, isString, isTimestamp, nullable, partitionRows, shaped } from '../../src/claude/guards.js';

describe('guards (#66)', () => {
  it('shaped confere cada campo e recusa o que não é objeto', () => {
    const guard = shaped<{ a: string; b: string | null }>({ a: isString, b: nullable(isString) });
    expect(guard({ a: 'x', b: null })).toBe(true);
    expect(guard({ a: 'x' })).toBe(false);
    expect(guard({ a: 1, b: null })).toBe(false);
    expect(guard(null)).toBe(false);
    expect(guard([])).toBe(false);
  });

  it('isInteger, isTimestamp e arrayOf', () => {
    expect(isInteger(3)).toBe(true);
    expect(isInteger(3.5)).toBe(false);
    expect(isInteger('3')).toBe(false);
    expect(isTimestamp('2026-11-15T12:00:00Z')).toBe(true);
    expect(isTimestamp('ontem')).toBe(false);
    expect(arrayOf(isString)(['a', 'b'])).toBe(true);
    expect(arrayOf(isString)(['a', 1])).toBe(false);
    expect(isRecord([])).toBe(false);
  });

  it('partitionRows devolve as válidas e conta as descartadas', () => {
    expect(partitionRows(['a', 1, null, 'b'], isString)).toEqual({ valid: ['a', 'b'], dropped: 2 });
  });
});
