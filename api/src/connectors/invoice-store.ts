// Gravação das notas capturadas e do resultado da conferência (invoices, divergences) (#59, AC-5).
import type { Invoice } from '../domain/index.js';
import { isString, parseRows, shaped, type Shape } from './guards.js';
import type { SupabaseRest } from './supabase-rest.js';

export interface InvoiceStore {
  /** #59 Regra 1: grava as notas novas e ignora a chave que já existe. Devolve as chaves gravadas agora. */
  insertNew(invoices: readonly Invoice[]): Promise<string[]>;
  /** #59 Chaves das notas ainda a conferir. */
  listPendingKeys(): Promise<string[]>;
  /** #59 Grava divergências e depois estado e classificação das notas conferidas (REL-3). */
  saveChecked(invoices: readonly Invoice[], checkedAt: string): Promise<void>;
}

function baseRow(invoice: Invoice): Record<string, unknown> {
  return {
    access_key: invoice.accessKey,
    number: invoice.number,
    series: invoice.series,
    supplier_id: invoice.supplierId,
    store: invoice.store,
    issued_on: invoice.issuedOn,
    purchase_order_ref: invoice.purchaseOrderRef,
    entry_channel: invoice.entryChannel,
    total_cents: invoice.total.cents,
    items: invoice.items.map((i) => ({
      supplierCode: i.supplierCode,
      sku: i.sku,
      description: i.description,
      quantity: { amount: i.quantity.amount, unit: i.quantity.unit },
      unitPriceCents: i.unitPrice.cents,
      totalCents: i.total.cents,
    })),
  };
}

// #59 Só a chave de acesso volta do PostgREST nas leituras desta loja; o guard a confere.
type InvoiceKeyRow = { access_key: string };
const isInvoiceKeyRow = shaped<InvoiceKeyRow>({ access_key: isString } satisfies Shape<InvoiceKeyRow>);

export class SupabaseInvoiceStore implements InvoiceStore {
  constructor(private readonly rest: SupabaseRest) {}

  async insertNew(invoices: readonly Invoice[]): Promise<string[]> {
    const rows = invoices.map((i) => ({ ...baseRow(i), state: i.state }));
    const inserted = await this.rest.insert('invoices', rows, { onConflict: 'access_key', ignoreDuplicates: true });
    return parseRows(inserted, isInvoiceKeyRow, 'invoices').map((r) => r.access_key);
  }

  async listPendingKeys(): Promise<string[]> {
    const rows = await this.rest.select('invoices', {
      select: 'access_key',
      filters: { state: 'eq.a_conferir' },
      order: 'access_key',
    });
    return parseRows(rows, isInvoiceKeyRow, 'invoices').map((r) => r.access_key);
  }

  /**
   * #59 REL-3: as divergências vão primeiro (upsert idempotente) e o estado depois. Se as divergências
   * falham, a nota segue a_conferir e a próxima rodada a confere de novo.
   */
  async saveChecked(invoices: readonly Invoice[], checkedAt: string): Promise<void> {
    if (invoices.length === 0) return;
    const divergences = invoices.flatMap((i) =>
      i.divergences.map((d, seq) => ({
        invoice_access_key: i.accessKey,
        seq,
        classification: d.classification,
        skus: [...d.skus],
        evidence: d.evidence,
      })),
    );
    await this.rest.upsert('divergences', divergences, 'invoice_access_key,seq');
    await this.rest.upsert(
      'invoices',
      invoices.map((i) => ({ ...baseRow(i), state: i.state, classification: i.classification, checked_at: checkedAt })),
      'access_key',
    );
  }
}
