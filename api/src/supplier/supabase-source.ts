import { arrayOf, isInteger, isNumber, isString, nullable, oneOf, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { Invoice, Money, Quantity } from '../domain/index.js';
import type { SourceInvoices } from './ports.js';

// #156: a nota de origem (invoices) e o e-mail de teste do fornecedor dela (kit_fornecedores.email).

type ItemJson = {
  supplierCode: string;
  sku: string | null;
  description: string;
  quantity: { amount: number; unit: 'UN' | 'CX' };
  unitPriceCents: number;
  totalCents: number;
};
type InvoiceRow = {
  access_key: string;
  number: string;
  series: string;
  supplier_id: string;
  store: string;
  issued_on: string;
  purchase_order_ref: string | null;
  entry_channel: string;
  total_cents: number;
  items: ItemJson[];
};
type EmailRow = { email: string | null };

const isItem = shaped<ItemJson>({
  supplierCode: isString,
  sku: nullable(isString),
  description: isString,
  quantity: shaped<ItemJson['quantity']>({ amount: isNumber, unit: oneOf('UN', 'CX') }),
  unitPriceCents: isInteger,
  totalCents: isInteger,
} satisfies Shape<ItemJson>);

const isInvoiceRow = shaped<InvoiceRow>({
  access_key: isString,
  number: isString,
  series: isString,
  supplier_id: isString,
  store: isString,
  issued_on: isString,
  purchase_order_ref: nullable(isString),
  entry_channel: isString,
  total_cents: isInteger,
  items: arrayOf(isItem),
} satisfies Shape<InvoiceRow>);

const isEmailRow = shaped<EmailRow>({ email: nullable(isString) } satisfies Shape<EmailRow>);

const invoiceOf = (row: InvoiceRow): Invoice =>
  Invoice.receive({
    accessKey: row.access_key,
    number: row.number,
    series: row.series,
    supplierId: row.supplier_id,
    store: row.store,
    issuedOn: row.issued_on,
    purchaseOrderRef: row.purchase_order_ref,
    entryChannel: row.entry_channel,
    items: row.items.map((i) => ({
      supplierCode: i.supplierCode,
      sku: i.sku,
      description: i.description,
      quantity: Quantity.of(i.quantity.amount, i.quantity.unit),
      unitPrice: Money.ofCents(i.unitPriceCents),
      total: Money.ofCents(i.totalCents),
    })),
    total: Money.ofCents(row.total_cents),
  });

/** #156: falha fechada: nota ausente, fornecedor ausente ou sem e-mail dão `null`, nunca um envio sem destinatário. */
export function supabaseSourceInvoices(rest: SupabaseRest): SourceInvoices {
  return {
    async find(invoiceAccessKey) {
      const [row] = parseRows(
        await rest.select('invoices', { filters: { access_key: `eq.${invoiceAccessKey}` }, limit: 1 }),
        isInvoiceRow,
        'invoices',
      );
      if (row === undefined) return null;
      const [supplier] = parseRows(
        await rest.select('kit_fornecedores', { select: 'email', filters: { fornecedor_id: `eq.${row.supplier_id}` }, limit: 1 }), // ADR-001
        isEmailRow,
        'kit_fornecedores',
      );
      if (supplier?.email === undefined || supplier.email === null) return null;
      return { invoice: invoiceOf(row), supplierEmail: supplier.email };
    },
  };
}
