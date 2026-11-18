import { isInteger, isIsoDate, isNumber, isRecord, isString, isUnknown, nullable, oneOf, parseOne, parseRows, shaped, type Shape } from '../connectors/guards.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import { issueReturnNote, type IssuedReturnNote, type ReturnNoteDraft, type ReturnNoteItem } from '../domain/index.js';
import type { IssuedNoteStore } from './ports.js';

// #12: a nota emitida pelo mock (issued_return_notes): um fato imutável, uma por devolução da fila (AC-2).
// #12: o id da linha é a sequência da emissão (ND-<id>, número <id>); a chave de acesso e o emitente não são
// #12: gravados: issueReturnNote é determinística e os refaz iguais a cada leitura (supabase/persistence-supplier-request.md).

const TABLE = 'issued_return_notes';

type Row = { id: number; queue_id: number; invoice_access_key: string; supplier_id: string; issued_on: string; note: unknown };

const isRow = shaped<Row>({
  id: isInteger,
  queue_id: isInteger,
  invoice_access_key: isString,
  supplier_id: isString,
  issued_on: isIsoDate,
  note: isUnknown,
} satisfies Shape<Row>);

type ItemJson = { supplierCode: string; sku: string | null; description: string; quantity: number; unit: 'UN' | 'CX'; unitPrice: number; value: number };

const isItem = shaped<ItemJson>({
  supplierCode: isString,
  sku: nullable(isString),
  description: isString,
  quantity: isNumber,
  unit: oneOf('UN', 'CX'),
  unitPrice: isNumber,
  value: isNumber,
} satisfies Shape<ItemJson>);

function corrupt(table: string, detail: string): never {
  throw new SupabaseRestError('parse', table, 0, detail);
}

/** #12: a nota montada como jsonb; o `jsonb` do Postgres reordena as chaves, então a leitura as põe na ordem da regra. */
export const noteToJson = (note: ReturnNoteDraft): unknown => ({
  nature: note.nature, // ADR-002
  referencedAccessKey: note.referencedAccessKey,
  supplierId: note.supplierId,
  destination: note.destination,
  items: note.items.map((i) => ({
    supplierCode: i.supplierCode,
    sku: i.sku,
    description: i.description,
    quantity: i.quantity,
    unit: i.unit,
    unitPrice: i.unitPrice,
    value: i.value,
  })),
  total: note.total,
});

export function noteFromJson(raw: unknown, table = TABLE): ReturnNoteDraft {
  if (!isRecord(raw) || raw.nature !== 'devolucao' || !Array.isArray(raw.items)) return corrupt(table, 'nota fora do formato'); // ADR-002
  const { referencedAccessKey, supplierId, destination, total } = raw;
  if (!isString(referencedAccessKey) || !isString(supplierId) || !isString(destination) || !isNumber(total)) {
    return corrupt(table, 'nota fora do formato');
  }
  const items = raw.items.map((item): ReturnNoteItem => {
    if (!isItem(item)) return corrupt(table, 'item da nota fora do formato');
    return Object.freeze({
      supplierCode: item.supplierCode,
      sku: item.sku,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
      value: item.value,
    });
  });
  return Object.freeze({
    nature: 'devolucao', // ADR-002
    referencedAccessKey,
    supplierId,
    destination,
    items: Object.freeze(items),
    total,
  });
}

const toIssued = (row: Row): IssuedReturnNote => issueReturnNote(noteFromJson(row.note), { sequence: row.id, issuedOn: row.issued_on });

/** #12: a nota emitida de uma linha de issued_return_notes, por id (o pedido guarda o id) ou por devolução da fila. */
export async function readIssuedNote(
  rest: SupabaseRest,
  by: { readonly id: number } | { readonly queueId: number },
): Promise<IssuedReturnNote | null> {
  const filters: Record<string, string> = 'id' in by ? { id: `eq.${by.id}` } : { queue_id: `eq.${by.queueId}` };
  const [row] = parseRows(await rest.select(TABLE, { filters, limit: 1 }), isRow, TABLE);
  return row === undefined ? null : toIssued(row);
}

/** #12/AC-2: só `select` e `insert`; a tabela é append-only e o grant recusa o resto. */
export function supabaseIssuedNoteStore(rest: SupabaseRest): IssuedNoteStore {
  return {
    async issue(queueId, draft, issuedOn) {
      const known = await readIssuedNote(rest, { queueId });
      if (known !== null) return known;
      const inserted = await rest.insert(
        TABLE,
        [{ queue_id: queueId, invoice_access_key: draft.referencedAccessKey, supplier_id: draft.supplierId, issued_on: issuedOn, note: noteToJson(draft) }],
        { onConflict: 'queue_id', ignoreDuplicates: true },
      );
      // #12/AC-2: nada voltou: outra emissão da mesma devolução confirmou antes; lê a que ficou.
      if (inserted.length === 0) {
        const winner = await readIssuedNote(rest, { queueId });
        return winner ?? corrupt(TABLE, 'a nota emitida da devolução não foi achada');
      }
      return toIssued(parseOne(inserted[0], isRow, TABLE));
    },
  };
}
