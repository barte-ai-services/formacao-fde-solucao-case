import type { IssuedReturnNote } from '../domain/index.js';
import type { MailAttachment } from './ports.js';
import { returnNotePdf } from './return-note-pdf.js';

// #156: a borda que leva a nota emitida do domínio (campos em inglês, #156) ao JSON do kit
// #156: (data/kit/notas.json, #156), em português. `emitente`, `nota_referenciada` e `natureza` não estão no kit:
// #156: vêm da tabela de saída aprovada em barte-ai-services/formacao-fde-solucao-case#156 (extensão da história #156).
// #156: O mapeamento é só nome de campo: os valores saem como a regra os deu.

export type KitReturnNoteItem = {
  readonly codigo_fornecedor: string; // ADR-001
  readonly sku: string | null; // ADR-001
  readonly descricao: string; // ADR-001
  readonly quantidade: number; // ADR-001
  readonly unidade: string; // ADR-001
  readonly preco_unitario: number; // ADR-001
  readonly valor: number; // ADR-001
};

export type KitReturnNote = {
  readonly nota_id: string; // ADR-001
  readonly chave: string; // ADR-001
  readonly numero: number; // ADR-001
  readonly serie: number; // ADR-001
  readonly emitente: { readonly nome: string; readonly destino: string }; // ADR-001 #156
  readonly fornecedor_id: string; // ADR-001
  readonly destino: string; // ADR-001
  readonly data_emissao: string; // ADR-001
  readonly nota_referenciada: string; // ADR-001 #156
  readonly natureza: string; // ADR-001 #156
  readonly itens: readonly KitReturnNoteItem[]; // ADR-001
  readonly valor_total: number; // ADR-001
};

/** #156 (#156): a nota emitida com os nomes de campo das notas do kit. */
export function toKitNote(note: IssuedReturnNote): KitReturnNote {
  return {
    nota_id: note.noteId, // ADR-001
    chave: note.accessKey, // ADR-001
    numero: note.number, // ADR-001
    serie: note.series, // ADR-001
    emitente: { nome: note.issuer.name, destino: note.issuer.destination }, // ADR-001 #156
    fornecedor_id: note.supplierId, // ADR-001
    destino: note.destination, // ADR-001
    data_emissao: note.issuedOn, // ADR-001
    nota_referenciada: note.referencedAccessKey, // ADR-001 #156
    natureza: note.nature, // ADR-001 #156
    itens: note.items.map((item) => ({ // ADR-001
      codigo_fornecedor: item.supplierCode, // ADR-001
      sku: item.sku, // ADR-001
      descricao: item.description, // ADR-001
      quantidade: item.quantity, // ADR-001
      unidade: item.unit, // ADR-001
      preco_unitario: item.unitPrice, // ADR-001
      valor: item.value, // ADR-001
    })),
    valor_total: note.total, // ADR-001
  };
}

/** #156: o nome dos anexos da nota, o mesmo para o JSON e o PDF, que só diferem na extensão. */
export const noteFilename = (note: IssuedReturnNote, extension: 'json' | 'pdf'): string => `nota-devolucao-${note.noteId}.${extension}`;

/** #156 (#156): o anexo do e-mail, a nota em JSON. */
export const kitNoteAttachment = (note: IssuedReturnNote): MailAttachment => ({
  filename: noteFilename(note, 'json'),
  contentType: 'application/json',
  content: JSON.stringify(toKitNote(note), null, 2),
});

/** #156: o anexo do e-mail, a mesma nota em PDF (função pura sobre a nota do kit, então os valores batem com o JSON). */
export const kitNotePdfAttachment = (note: IssuedReturnNote): MailAttachment => ({
  filename: noteFilename(note, 'pdf'),
  contentType: 'application/pdf',
  content: returnNotePdf(toKitNote(note)),
});
