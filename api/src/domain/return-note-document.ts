import { parseIsoDate } from './calendar.js';
import { DomainError } from './errors.js';
import type { InvoiceItem, InvoiceView } from './invoice.js';
import { Money } from './money.js';
import type { Unit } from './quantity.js';

// #156: a nota de devolução no formato das notas do kit (data/kit/notas.json), montada pela regra.
// #156: os campos têm o nome em inglês, par a par com os do kit (ADR-002 só mantém em português o valor
// #156: `devolucao` da natureza); o mapeamento para o JSON do kit é da borda. O dinheiro sai em reais,
// #156: derivado dos centavos exatos de `Money`.

/** #156: a linha da fila (`outbox_return_notes.payload.lines`): o que voltou, na unidade da nota. */
export type ReturnQueueLine = { readonly supplierCode: string; readonly amount: number; readonly unit: Unit };

/** #156: a devolução pendente da fila que vira nota. */
export type ReturnQueueEntry = { readonly invoiceAccessKey: string; readonly lines: readonly ReturnQueueLine[] };

export type ReturnNoteItem = {
  readonly supplierCode: string;
  readonly sku: string | null;
  readonly description: string;
  readonly quantity: number;
  readonly unit: Unit;
  readonly unitPrice: number;
  readonly value: number;
};

/** #156: a nota montada, ainda sem emissão. */
export type ReturnNoteDraft = {
  readonly nature: 'devolucao'; // ADR-002
  readonly referencedAccessKey: string;
  readonly supplierId: string;
  readonly destination: string;
  readonly items: readonly ReturnNoteItem[];
  readonly total: number;
};

/** #156: a nota emitida pelo mock. O emitente leva só o nome e o destino: o kit não tem CNPJ de destino. */
export type IssuedReturnNote = ReturnNoteDraft & {
  readonly noteId: string;
  readonly accessKey: string;
  readonly number: number;
  readonly series: number;
  readonly issuedOn: string;
  readonly issuer: { readonly name: string; readonly destination: string };
};

const reais = (money: Money): number => money.cents / 100;

/** #156: a mesma conta da fila (`return-notes.ts`): quantidade x preço unitário, em centavos. */
const lineValue = (item: InvoiceItem, amount: number): Money => Money.ofCents(Math.round(item.unitPrice.cents * amount));

function toNoteItem(line: ReturnQueueLine, invoice: InvoiceView): ReturnNoteItem {
  const item = invoice.items.find((i) => i.supplierCode === line.supplierCode);
  if (item === undefined) {
    throw new DomainError(`Nota de devolução: a nota de origem não tem a linha ${line.supplierCode}`);
  }
  if (item.quantity.unit !== line.unit) {
    throw new DomainError(`Nota de devolução: a linha ${line.supplierCode} deve voltar na unidade da nota`);
  }
  if (!Number.isFinite(line.amount) || line.amount <= 0) {
    throw new DomainError(`Nota de devolução: quantidade inválida na linha ${line.supplierCode}`);
  }
  return Object.freeze({
    supplierCode: item.supplierCode,
    sku: item.sku,
    description: item.description,
    quantity: line.amount,
    unit: item.quantity.unit,
    unitPrice: reais(item.unitPrice),
    value: reais(lineValue(item, line.amount)),
  });
}

/** #156: monta a nota de devolução só com as linhas devolvidas, e o total é a soma exata dos itens. */
export function buildReturnNote(entry: ReturnQueueEntry, invoice: InvoiceView): ReturnNoteDraft {
  if (entry.invoiceAccessKey !== invoice.accessKey) {
    throw new DomainError('Nota de devolução: a devolução é de outra nota');
  }
  if (entry.lines.length === 0) throw new DomainError('Nota de devolução: a devolução não tem linhas');
  const items = entry.lines.map((line) => toNoteItem(line, invoice));
  // #156: cada valor já é centavos exatos em reais; voltar a centavos é exato, então a soma também.
  const total = items.reduce((sum, item) => sum.add(Money.fromReais(item.value)), Money.zero());
  return Object.freeze({
    nature: 'devolucao', // ADR-002
    referencedAccessKey: invoice.accessKey,
    supplierId: invoice.supplierId,
    destination: invoice.store,
    items: Object.freeze(items),
    total: reais(total),
  });
}

/** #156: a série própria das devoluções, que não repete a série das notas de compra do kit. */
export const RETURN_NOTE_SERIES = 9;

const MAX_SEQUENCE = 999_999_999;
const ISSUER_NAME = 'Já Chegou'; // #156: a operadora fictícia do caso (AGENTS.md)

/** #156: dígito verificador módulo 11 da chave de acesso, pesos de 2 a 9 da direita para a esquerda. */
function checkDigit(digits: string): number {
  let weight = 2;
  let total = 0;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    total += Number(digits[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = total % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/**
 * #156: a chave de 44 algarismos do mock, determinística e única por sequência (o número da nota
 * entra nela). Não inventa CNPJ: o campo do emitente vai zerado.
 */
function mockAccessKey(sequence: number, issuedOn: string): string {
  const yearMonth = issuedOn.slice(2, 4) + issuedOn.slice(5, 7);
  const code = String((sequence * 7919 + 12_345_678) % 100_000_000).padStart(8, '0');
  const body = `35${yearMonth}${'0'.repeat(14)}55${String(RETURN_NOTE_SERIES).padStart(3, '0')}${String(sequence).padStart(9, '0')}1${code}`;
  return `${body}${checkDigit(body)}`;
}

/** #156: a emissão mock: dados a sequência, a data e a nota montada, sai a nota com id, chave, número e série. */
export function issueReturnNote(
  draft: ReturnNoteDraft,
  emission: { readonly sequence: number; readonly issuedOn: string },
): IssuedReturnNote {
  const { sequence, issuedOn } = emission;
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) {
    throw new DomainError('Emissão mock: a sequência deve ser um inteiro de 1 a 999999999');
  }
  parseIsoDate(issuedOn);
  return Object.freeze({
    ...draft,
    noteId: `ND-${sequence}`,
    accessKey: mockAccessKey(sequence, issuedOn),
    number: sequence,
    series: RETURN_NOTE_SERIES,
    issuedOn,
    issuer: Object.freeze({ name: ISSUER_NAME, destination: draft.destination }),
  });
}
