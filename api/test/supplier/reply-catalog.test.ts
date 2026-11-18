import { describe, expect, it } from 'vitest';
import { catalogOf, todayIso } from '../../src/supplier/reply-catalog.js';
import { replyRequest } from './reply-doubles.js';

// #34: o que a leitura e a cobrança dividem: o dia de hoje e o catálogo do pedido. Nomes de `it` no ADR-004.

describe('#34/AC-3: todayIso é o dia de São Paulo', () => {
  it('na virada do fuso, 02:30 UTC ainda é o dia anterior em São Paulo', () => {
    expect(todayIso(new Date('2026-11-20T02:30:00Z'))).toBe('2026-11-19');
  });

  it('depois da meia-noite de São Paulo, o dia vira', () => {
    expect(todayIso(new Date('2026-11-20T03:00:00Z'))).toBe('2026-11-20');
  });
});

describe('#34/AC-3: catalogOf refaz o catálogo do pedido', () => {
  it('leva o número da nota de origem do pedido', () => {
    expect(catalogOf(replyRequest(7)).facts['nota.numero']?.value).toBe('43894');
  });

  it('leva o prazo gravado: muda com o dueOn do pedido', () => {
    const due = catalogOf(replyRequest(7)).facts['prazo']?.value;
    expect(due).toBeDefined();
    expect(catalogOf(replyRequest(7, { dueOn: '2026-12-01' })).facts['prazo']?.value).not.toBe(due);
  });
});
