import { describe, expect, it } from 'vitest';
import { Money, Title } from '../../src/domain/index.js';

const aTitle = () => Title.post({ invoiceAccessKey: 'K1', amount: Money.ofCents(10000), dueOn: '2026-11-20' });

describe('Title', () => {
  it('nasce lançado', () => {
    expect(aTitle().state).toBe('lancado');
  });

  it('liberado entra na lista do dia', () => {
    const t = aTitle();
    t.release();
    t.scheduleToday();
    expect(t.state).toBe('na_lista_do_dia');
  });

  it('reduzido entra na lista do dia com o valor novo', () => {
    const t = aTitle();
    t.reduce(Money.ofCents(4000));
    expect(t.state).toBe('reduzido');
    expect(t.amount.cents).toBe(4000);
    t.scheduleToday();
    expect(t.state).toBe('na_lista_do_dia');
  });

  it('reduzir exige 0 < novo valor < valor atual', () => {
    expect(() => aTitle().reduce(Money.zero())).toThrow();
    expect(() => aTitle().reduce(Money.ofCents(10000))).toThrow();
    expect(() => aTitle().reduce(Money.ofCents(-1))).toThrow();
  });

  it('bloqueado não entra na lista do dia; inválidas lançam', () => {
    const t = aTitle();
    t.block();
    expect(t.state).toBe('bloqueado');
    expect(() => t.scheduleToday()).toThrow();
    expect(() => t.release()).toThrow();
    expect(() => aTitle().scheduleToday()).toThrow();
    const s = aTitle();
    s.release();
    s.scheduleToday();
    expect(() => s.block()).toThrow();
  });
});
