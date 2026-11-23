import { describe, expect, it } from 'vitest';
import {
  DEMO_NOTES_MAX,
  DEMO_NOTES_MIN,
  demoNoteCount,
  generateDemoBatch,
  nextSequenceStart,
  type DemoBatch,
  type DemoBatchInput,
} from '../../src/demo/generator.js';

const NOW = new Date('2026-11-23T12:00:00Z');
const input = (over: Partial<DemoBatchInput> = {}): DemoBatchInput => ({ seed: 1, count: 5, now: NOW, sequenceStart: 1, ...over });

/** Lotes de 8 notas, cada um com a semente e o início de sequência da rodada seguinte, até somar `total` notas. (#349) */
function rounds(total: number, firstSeed = 100): DemoBatch[] {
  const batches: DemoBatch[] = [];
  let sequenceStart = 1;
  for (let n = 0, seed = firstSeed; n < total; seed += 1) {
    const count = Math.min(DEMO_NOTES_MAX, total - n);
    batches.push(generateDemoBatch(input({ seed, count, sequenceStart })));
    sequenceStart = nextSequenceStart(sequenceStart, count);
    n += count;
  }
  return batches;
}

describe('#349 gerador de notas da demonstração', () => {
  it('#349/AC-1 cada rodada emite de 3 a 8 notas novas, e o número vem da semente', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const count = demoNoteCount(seed);
      expect(count).toBeGreaterThanOrEqual(DEMO_NOTES_MIN);
      expect(count).toBeLessThanOrEqual(DEMO_NOTES_MAX);
      expect(generateDemoBatch(input({ seed, count })).rows.kit_notas).toHaveLength(count);
    }
    const counts = new Set(Array.from({ length: 200 }, (_, i) => demoNoteCount(i + 1)));
    expect([...counts].sort()).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('#349/AC-1 recusa quantidade fora de 3 a 8', () => {
    for (const count of [0, 2, 9, 3.5]) {
      expect(() => generateDemoBatch(input({ count }))).toThrow(RangeError);
    }
  });

  it('é determinístico: a mesma semente, o mesmo instante e o mesmo início dão as mesmas linhas', () => {
    const a = generateDemoBatch(input({ seed: 42 }));
    const b = generateDemoBatch(input({ seed: 42 }));
    expect(b.rows).toEqual(a.rows);
    expect([...b.expected]).toEqual([...a.expected]);
    expect(generateDemoBatch(input({ seed: 43 })).rows).not.toEqual(a.rows);
  });

  it('toda nota leva origin = demo, nota_id DM- e uma chave de acesso de 44 dígitos', () => {
    for (const { rows } of rounds(40)) {
      for (const nota of rows.kit_notas) {
        expect(nota.origin).toBe('demo');
        expect(nota.nota_id).toMatch(/^DM-\d{5,}$/);
        expect(nota.chave).toMatch(/^\d{44}$/);
      }
    }
  });

  it('ordem, recebimento e pagamento usam prefixo próprio, que nunca colide com a base', () => {
    for (const { rows } of rounds(40)) {
      for (const o of rows.kit_ordens) expect(o.ordem_id).toMatch(/^OC-DM-\d+$/);
      for (const r of rows.kit_recebimentos) expect(r.recebimento_id).toMatch(/^RC-DM-\d+$/);
      for (const p of rows.kit_pagamentos) expect(p.pagamento_id).toMatch(/^PG-DM-\d+$/);
    }
  });

  it('as linhas são coerentes: pais antes dos filhos, itens somam o total e a ordem citada existe', () => {
    for (const { rows } of rounds(60)) {
      const orders = new Set(rows.kit_ordens.map((o) => o.ordem_id));
      const keys = new Set(rows.kit_notas.map((n) => n.chave));
      for (const nota of rows.kit_notas) {
        if (nota.pedido_referenciado !== null && !nota.pedido_referenciado.startsWith('OC-DM-')) throw new Error('ordem fora do prefixo');
        const items = rows.kit_nota_itens.filter((i) => i.chave === nota.chave);
        expect(items.length).toBeGreaterThan(0);
        const sum = items.reduce((acc, i) => acc + Math.round(Number(i.valor) * 100), 0);
        expect(sum).toBe(Math.round(Number(nota.valor_total) * 100));
      }
      for (const i of rows.kit_nota_itens) expect(keys.has(i.chave)).toBe(true);
      for (const i of rows.kit_ordem_itens) expect(orders.has(i.ordem_id)).toBe(true);
      for (const n of rows.kit_notas) if (n.pedido_referenciado !== null) expect(orders.has(n.pedido_referenciado)).toBe(true);
      const receipts = new Set(rows.kit_recebimentos.map((r) => r.recebimento_id));
      for (const i of rows.kit_recebimento_itens) expect(receipts.has(i.recebimento_id)).toBe(true);
    }
  });

  it('a classificação esperada fica só em memória: nenhuma linha leva gabarito, tipo de caso ou ação', () => {
    const batch = generateDemoBatch(input({ seed: 7, count: 8 }));
    const text = JSON.stringify(batch.rows).toLowerCase();
    for (const forbidden of ['gabarito', 'registrar', 'encaminhar', 'acao_doca', 'tipo_caso', 'explicacao', 'classificacao', 'classification']) {
      expect(text).not.toContain(forbidden);
    }
    for (const nota of batch.rows.kit_notas) expect(batch.expected.has(nota.chave)).toBe(true);
    expect(batch.expected.size).toBe(8);
  });

  it('o início da sequência da rodada seguinte é o início mais a quantidade', () => {
    expect(nextSequenceStart(10, 5)).toBe(15);
  });

  it('#349/AC-4 nenhuma nota repete chave ou nota_id dentro do lote nem entre rodadas', () => {
    const notas = rounds(100).flatMap((b) => b.rows.kit_notas);
    expect(new Set(notas.map((n) => n.chave)).size).toBe(notas.length);
    expect(new Set(notas.map((n) => n.nota_id)).size).toBe(notas.length);
  });

  it('#349/AC-4 chaves já tomadas são evitadas', () => {
    const first = generateDemoBatch(input({ seed: 9 }));
    const taken = new Set(first.rows.kit_notas.map((n) => n.chave));
    const again = generateDemoBatch(input({ seed: 9, takenKeys: taken }));
    for (const nota of again.rows.kit_notas) expect(taken.has(nota.chave)).toBe(false);
  });

  it('#349/AC-2 em 100 notas aparecem todas as exceções, o match e todos os níveis da régua', () => {
    const expected = rounds(100).flatMap((b) => [...b.expected.values()]);
    expect(expected).toHaveLength(100);
    const classes = new Set(expected.map((e) => e.classification));
    for (const c of ['MATCH', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']) expect(classes.has(c as never)).toBe(true);
    const levels = new Set(expected.map((e) => e.level));
    for (const l of ['regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio']) expect(levels.has(l as never)).toBe(true);
    const matches = expected.filter((e) => e.classification === 'MATCH').length;
    expect(matches).toBeGreaterThanOrEqual(3);
    expect(matches).toBeLessThanOrEqual(20);
  });
});
