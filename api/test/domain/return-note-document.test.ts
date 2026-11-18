import { describe, expect, it } from 'vitest';
import { DomainError, buildReturnNote, issueReturnNote } from '../../src/domain/index.js';
import { SOURCE_KEY, queueEntry, returnNote, sourceInvoice } from './supplier-request-fixtures.js';

describe('a nota de devolução montada pela regra', () => {
  it('#156 cita a chave da nota de origem e sai com natureza devolucao', () => {
    const note = returnNote();
    expect(note.referencedAccessKey).toBe(SOURCE_KEY);
    expect(note.nature).toBe('devolucao');
  });

  it('#156 leva o fornecedor e o destino da nota de origem', () => {
    const note = returnNote();
    expect(note.supplierId).toBe('F02');
    expect(note.destination).toBe('LJ-012');
  });

  it('#156 tem só as linhas devolvidas, com os dados da nota de origem', () => {
    expect(returnNote().items).toEqual([
      {
        supplierCode: 'F02-002',
        sku: 'SKU-1006',
        description: 'Refrigerante cola 2 L',
        quantity: 7,
        unit: 'UN',
        unitPrice: 8.49,
        value: 59.43,
      },
      {
        supplierCode: 'F02-005',
        sku: null,
        description: 'Arroz 5 kg',
        quantity: 5,
        unit: 'CX',
        unitPrice: 100,
        value: 500,
      },
    ]);
  });

  it('#156 o total é a soma exata dos itens, igual ao valor da devolução da fila', () => {
    const note = returnNote();
    expect(note.total).toBe(559.43);
    // #156: a fila valora por quantity x preço unitário, arredondado em centavos (api/src/returns/return-notes.ts)
    const queueCents = Math.round(849 * 7) + Math.round(10000 * 5);
    expect(Math.round(note.total * 100)).toBe(queueCents);
  });

  it('#156 uma quantidade fracionada fecha com o valor que a fila calcula', () => {
    const note = buildReturnNote(queueEntry({ lines: [{ supplierCode: 'F02-005', amount: 7 / 6, unit: 'CX' }] }), sourceInvoice());
    expect(Math.round(note.total * 100)).toBe(Math.round(10000 * (7 / 6)));
  });

  it('#156 recusa linha que a nota de origem não tem', () => {
    const entry = queueEntry({ lines: [{ supplierCode: 'F99-001', amount: 1, unit: 'UN' }] });
    expect(() => buildReturnNote(entry, sourceInvoice())).toThrow(DomainError);
  });

  it('#156 recusa devolução sem linhas, de outra nota ou em unidade diferente da nota', () => {
    expect(() => buildReturnNote(queueEntry({ lines: [] }), sourceInvoice())).toThrow(DomainError);
    expect(() => buildReturnNote(queueEntry({ invoiceAccessKey: '1'.repeat(44) }), sourceInvoice())).toThrow(DomainError);
    const wrongUnit = queueEntry({ lines: [{ supplierCode: 'F02-005', amount: 1, unit: 'UN' }] });
    expect(() => buildReturnNote(wrongUnit, sourceInvoice())).toThrow(DomainError);
  });
});

describe('a emissão mock da nota de devolução', () => {
  const issue = (sequence: number, issuedOn = '2026-11-12') => issueReturnNote(returnNote(), { sequence, issuedOn });

  it('#156 dá o noteId ND-n, o número e a série próprios, a natureza e a data', () => {
    const issued = issue(7);
    expect(issued.noteId).toBe('ND-7');
    expect(issued.number).toBe(7);
    expect(issued.series).toBe(9);
    expect(issued.nature).toBe('devolucao');
    expect(issued.issuedOn).toBe('2026-11-12');
  });

  it('#156 a chave tem 44 algarismos e só algarismos', () => {
    expect(issue(7).accessKey).toMatch(/^\d{44}$/);
  });

  it('#156 sequências diferentes dão chaves diferentes e a mesma sequência dá a mesma chave', () => {
    const keys = new Set([1, 2, 3, 10, 999].map((n) => issue(n).accessKey));
    expect(keys.size).toBe(5);
    expect(issue(3).accessKey).toBe(issue(3).accessKey);
  });

  it('#156 mantém a nota montada: itens, total e a chave de origem', () => {
    const issued = issue(1);
    expect(issued.items).toEqual(returnNote().items);
    expect(issued.total).toBe(559.43);
    expect(issued.referencedAccessKey).toBe(SOURCE_KEY);
  });

  it('#156 o emitente é a Já Chegou e o destino que devolve, sem CNPJ inventado', () => {
    const { issuer } = issue(1);
    expect(issuer).toEqual({ name: 'Já Chegou', destination: 'LJ-012' });
  });

  it('#156 recusa sequência que não é inteiro positivo ou não cabe na chave', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 1_000_000_000]) {
      expect(() => issue(bad)).toThrow(DomainError);
    }
  });

  it('#156 recusa data de emissão que não é AAAA-MM-DD', () => {
    expect(() => issue(1, '12/11/2026')).toThrow(DomainError);
  });
});

// #156: o kit nomeia os campos em português (data/kit/notas.json); o domínio os nomeia em inglês.
// #156: o mapeamento para o JSON do kit é da borda, não do domínio.
const KIT_NOTE_FIELDS = {
  nota_id: 'noteId', // ADR-001
  chave: 'accessKey', // ADR-001
  numero: 'number', // ADR-001
  serie: 'series', // ADR-001
  fornecedor_id: 'supplierId', // ADR-001
  destino: 'destination', // ADR-001
  data_emissao: 'issuedOn', // ADR-001
  itens: 'items', // ADR-001
  valor_total: 'total', // ADR-001
} as const;

const KIT_ITEM_FIELDS = {
  codigo_fornecedor: 'supplierCode', // ADR-001
  sku: 'sku',
  descricao: 'description', // ADR-001
  quantidade: 'quantity', // ADR-001
  unidade: 'unit', // ADR-001
  preco_unitario: 'unitPrice', // ADR-001
  valor: 'value', // ADR-001
} as const;

describe('os campos da nota de devolução e os da nota do kit', () => {
  it('#156 todo campo da nota do kit tem o seu par, em inglês, na nota emitida e em cada item', () => {
    const issued = issueReturnNote(returnNote(), { sequence: 1, issuedOn: '2026-11-12' });
    for (const field of Object.values(KIT_NOTE_FIELDS)) expect(issued).toHaveProperty(field);
    for (const item of issued.items) {
      for (const field of Object.values(KIT_ITEM_FIELDS)) expect(item).toHaveProperty(field);
    }
  });

  it('#156 o único literal em português é o valor devolucao da natureza; nenhum nome de campo é português', () => {
    const issued = issueReturnNote(returnNote(), { sequence: 1, issuedOn: '2026-11-12' });
    const names = [...Object.keys(issued), ...Object.keys(issued.items[0] ?? {}), ...Object.keys(issued.issuer)];
    for (const portuguese of Object.keys(KIT_NOTE_FIELDS)) expect(names).not.toContain(portuguese);
    for (const portuguese of Object.keys(KIT_ITEM_FIELDS)) {
      if (portuguese !== 'sku') expect(names).not.toContain(portuguese);
    }
    expect(issued.nature).toBe('devolucao');
  });
});
