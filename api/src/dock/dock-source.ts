// Leitura da doca no Supabase: as notas do dia e as ações publicadas para o WMS (#72, #43 AC-4).
import { arrayOf, isNumber, isString, nullable, oneOf, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { DockActionMessage, Published } from '../connectors/ports.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { appStoreActionOutbox } from '../connectors/store-action.js';
import { wmsDockActionOutbox } from '../connectors/wms-dock-action.js';
import type { DockInvoice, DockInvoiceItem } from './dock-board.js';

export interface DockSource {
  /** #72 As notas emitidas na data (AAAA-MM-DD), de todos os destinos. */
  invoicesOn(date: string): Promise<DockInvoice[]>;
  /**
   * #72 As ações publicadas na caixa de saída do WMS, em ordem de id. Lê a tabela inteira, porque o
   * conector ainda não filtra pelas chaves do dia; o filtro fica para um ajuste no conector.
   */
  published(): Promise<Published<DockActionMessage>[]>;
  /** #135 As ações publicadas na caixa de saída do app da loja, em ordem de id. */
  publishedToStores(): Promise<Published<DockActionMessage>[]>;
}

type ItemRow = { sku: string | null; description: string; quantity: { amount: number; unit: 'UN' | 'CX' } };
type InvoiceRow = {
  access_key: string;
  number: string;
  supplier_id: string;
  store: string;
  issued_on: string;
  items: ItemRow[];
};

const isItemRow = shaped<ItemRow>({
  sku: nullable(isString),
  description: isString,
  quantity: shaped<ItemRow['quantity']>({ amount: isNumber, unit: oneOf('UN', 'CX') }),
} satisfies Shape<ItemRow>);

const isInvoiceRow = shaped<InvoiceRow>({
  access_key: isString,
  number: isString,
  supplier_id: isString,
  store: isString,
  issued_on: isString,
  items: arrayOf(isItemRow),
} satisfies Shape<InvoiceRow>);

const COLUMNS = 'access_key,number,supplier_id,store,issued_on,items';

const toItem = (i: ItemRow): DockInvoiceItem => ({
  sku: i.sku,
  description: i.description,
  quantity: { amount: i.quantity.amount, unit: i.quantity.unit },
});

export function supabaseDockSource(rest: SupabaseRest): DockSource {
  const outbox = wmsDockActionOutbox(rest);
  const storeOutbox = appStoreActionOutbox(rest);
  return {
    async invoicesOn(date) {
      const rows = await rest.select('invoices', { select: COLUMNS, filters: { issued_on: `eq.${date}` }, order: 'access_key' });
      return parseRows(rows, isInvoiceRow, 'invoices').map((r) => ({
        accessKey: r.access_key,
        number: r.number,
        supplierId: r.supplier_id,
        store: r.store,
        issuedOn: r.issued_on,
        items: r.items.map(toItem),
      }));
    },
    published: () => outbox.list(),
    publishedToStores: () => storeOutbox.list(),
  };
}
