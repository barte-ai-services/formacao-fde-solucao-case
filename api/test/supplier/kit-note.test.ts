import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { issueReturnNote } from '../../src/domain/index.js';
import { kitNoteAttachment, kitNotePdfAttachment, toKitNote } from '../../src/supplier/kit-note.js';
import { returnNotePdf } from '../../src/supplier/return-note-pdf.js';
import { SOURCE_KEY, returnNote } from '../domain/supplier-request-fixtures.js';

// #11: testes da borda que leva a nota emitida ao JSON do kit (api/src/supplier/kit-note.ts), chamada direto.

const issued = () => issueReturnNote(returnNote(), { sequence: 101, issuedOn: '2026-11-12' });

/** #11: os campos de cada nota do kit (data/kit/notas.json), lidos do arquivo e não escritos à mão aqui. */
const kitFields = (): string[] => {
  const notas: Array<Record<string, unknown>> = JSON.parse(readFileSync(new URL('../../../data/kit/notas.json', import.meta.url), 'utf8'));
  return Object.keys(notas[0] ?? {});
};

describe('#11/AC-4 a nota anexa é o JSON no formato do kit', () => { // ADR-002
  it('traz os campos da nota, a nota de origem e as linhas devolvidas, em português', () => { // ADR-002
    const note = toKitNote(issued());
    expect(note).toMatchObject({
      nota_id: 'ND-101',
      numero: 101,
      serie: 9,
      fornecedor_id: 'F02',
      destino: 'LJ-012',
      data_emissao: '2026-11-12',
      natureza: 'devolucao',
      valor_total: 559.43,
    });
    expect(note.chave).toMatch(/^\d{44}$/);
    expect(note.nota_referenciada).toBe(SOURCE_KEY);
    expect(note.itens).toEqual([
      { codigo_fornecedor: 'F02-002', sku: 'SKU-1006', descricao: 'Refrigerante cola 2 L', quantidade: 7, unidade: 'UN', preco_unitario: 8.49, valor: 59.43 },
      { codigo_fornecedor: 'F02-005', sku: null, descricao: 'Arroz 5 kg', quantidade: 5, unidade: 'CX', preco_unitario: 100, valor: 500 },
    ]);
  });

  it('cada campo das notas do kit está presente, além de emitente, nota_referenciada e natureza', () => { // ADR-002
    const note = toKitNote(issued());
    const keys = Object.keys(note);
    const own = ['nota_id', 'chave', 'numero', 'serie', 'fornecedor_id', 'destino', 'data_emissao', 'itens'];
    for (const field of own) expect(keys).toContain(field);
    // #11: do kit ficam de fora só os campos de uma nota de compra: pedido e canal de entrada.
    for (const field of kitFields().filter((f) => f !== 'pedido_referenciado' && f !== 'canal_entrada')) expect(keys).toContain(field);
    for (const field of ['emitente', 'nota_referenciada', 'natureza']) expect(keys).toContain(field);
    expect(note.emitente).toEqual({ nome: expect.any(String), destino: 'LJ-012' });
  });

  it('#57/AC-1: o anexo se chama nota-devolucao-<nota_id>.json, é application/json e o conteúdo é a nota do kit', () => { // ADR-002
    const attachment = kitNoteAttachment(issued());
    expect(attachment.filename).toBe('nota-devolucao-ND-101.json');
    expect(attachment.contentType).toBe('application/json');
    expect(JSON.parse(attachment.content)).toEqual(JSON.parse(JSON.stringify(toKitNote(issued()))));
  });
});

describe('#57/AC-1 o anexo em PDF da nota', () => { // ADR-002
  it('#57/AC-1: se chama nota-devolucao-<nota_id>.pdf, é application/pdf e o conteúdo é o PDF da mesma nota do JSON', () => { // ADR-002
    const attachment = kitNotePdfAttachment(issued());
    expect(attachment.filename).toBe('nota-devolucao-ND-101.pdf');
    expect(attachment.contentType).toBe('application/pdf');
    expect(attachment.content).toBe(returnNotePdf(toKitNote(issued())));
  });
});
