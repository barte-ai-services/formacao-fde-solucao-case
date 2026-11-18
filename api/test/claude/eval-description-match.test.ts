/** Testes do conjunto do eval do casamento de descrição (#66, AC-6): só o kit, nunca o gabarito. */
import { describe, expect, it } from 'vitest';
import { buildEvalDataset, narrowKit, summarize, variants } from '../../src/claude/eval-description-match.js';

const PRODUTOS = [
  { sku: 'SKU-1', descricao: 'Refrigerante cola 2 L', fornecedor_id: 'F02', codigo_fornecedor: 'F02-001' },
  { sku: 'SKU-2', descricao: 'Água de coco 1 L', fornecedor_id: 'F02', codigo_fornecedor: 'F02-002' },
  { sku: 'SKU-3', descricao: 'Banana prata kg', fornecedor_id: 'F02', codigo_fornecedor: 'F02-003' },
];
const NOTAS = [
  {
    chave: 'N1', // ADR-001
    fornecedor_id: 'F02',
    itens: [
      { codigo_fornecedor: 'F02-001', sku: 'SKU-1', descricao: 'Refrigerante cola 2 L' },
      { codigo_fornecedor: 'F02-N27', sku: null, descricao: 'Isotônico limão 500 ml (lançamento)' },
    ],
  },
];

describe('variantes do eval (#66, AC-6)', () => {
  it('gera as variantes determinísticas de uma descrição', () => {
    const v = Object.fromEntries(variants('Refrigerante cola 2 L').map((x) => [x.variant, x.description]));
    expect(v).toEqual({
      'abreviacao-com-ponto': 'Refri. cola 2 L',
      'abreviacao-sem-ponto': 'Refri cola 2 L',
      'palavras-reordenadas': '2 L Refrigerante cola',
      'medida-reescrita': 'Refrigerante cola 2000 ml',
      'sufixo-ruido': 'Refrigerante cola 2 L cx c/12',
      'ultima-palavra-removida': 'Refrigerante 2 L',
    });
  });

  it('converte medida com vírgula e de ml para L', () => {
    const measure = (d: string) => variants(d).find((x) => x.variant === 'medida-reescrita')?.description;
    expect(measure('Água mineral 1,5 L')).toBe('Água mineral 1500 ml');
    expect(measure('Shampoo 350 ml')).toBe('Shampoo 0,35 L');
    expect(measure('Sabão em pó 1,6 kg')).toBe('Sabão em pó 1600 g');
    expect(measure('Banana prata kg')).toBeUndefined();
  });
});

describe('conjunto do eval (#66, AC-6)', () => {
  it('positivos vêm dos itens com sku; negativos, dos itens sem sku e das medidas dobradas', () => {
    const cases = buildEvalDataset(NOTAS, PRODUTOS);
    const positives = cases.filter((c) => c.expected !== null);
    const negatives = cases.filter((c) => c.expected === null);
    expect(positives.length).toBeGreaterThan(0);
    expect(positives.every((c) => c.expected === 'Refrigerante cola 2 L')).toBe(true);
    expect(positives.every((c) => c.input.candidates.join('|') === 'Água de coco 1 L|Banana prata kg|Refrigerante cola 2 L')).toBe(true);
    expect(negatives.map((c) => c.input.description)).toEqual([
      'Isotônico limão 500 ml (lançamento)',
      'Refrigerante cola 4 L',
      'Água de coco 2 L',
    ]);
  });

  it('resume acurácia, precisão, revocação e falsos positivos', () => {
    const r = summarize([
      { variant: 'a', expected: 'X', answer: 'X', failed: false },
      { variant: 'a', expected: 'X', answer: null, failed: false },
      { variant: 'b', expected: 'X', answer: 'Y', failed: false },
      { variant: 'negativo', expected: null, answer: 'X', failed: false },
      { variant: 'negativo', expected: null, answer: null, failed: true },
    ]);
    expect(r.total).toBe(5);
    expect(r.claudeFailures).toBe(1);
    expect(r.falsePositivesOnNegatives).toBe(1);
    expect(r.precision).toBeCloseTo(1 / 3);
    expect(r.recall).toBeCloseTo(1 / 3);
    expect(r.byVariant.a).toEqual({ total: 2, correct: 1, accuracy: 0.5 });
  });
});

describe('leitura do kit estreitada por guard (#66, AC-6)', () => {
  it('descarta as linhas fora do formato, conta e segue', () => {
    const result = narrowKit(
      [...NOTAS, { chave: 'N2', fornecedor_id: 'F02', itens: [{ sku: null }] }, 'lixo'],
      [...PRODUTOS, { sku: 'SKU-9', descricao: null }],
    );
    expect(result.notas).toEqual(NOTAS);
    expect(result.produtos).toEqual(PRODUTOS);
    expect(result.dropped).toBe(3);
  });

  it('um arquivo que não é uma lista é erro, nomeando o arquivo', () => {
    expect(() => narrowKit({}, [])).toThrow(/notas\.json/);
    expect(() => narrowKit([], 'x')).toThrow(/produtos\.json/);
  });
});
