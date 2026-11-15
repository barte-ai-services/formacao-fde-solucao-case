// Gravação das notas capturadas e do resultado da conferência (invoices, divergences) (#59, AC-5).
import type { Invoice } from '../domain/index.js';
import type { SupabaseRest } from './supabase-rest.js';

export interface InvoiceStore {
  /** #59 Regra 1: grava as notas novas e ignora a chave que já existe. Devolve as chaves gravadas agora. */
  insertNew(invoices: readonly Invoice[]): Promise<string[]>;
  /** #59 Chaves das notas ainda a conferir. */
  listPendingKeys(): Promise<string[]>;
  /** #59 Grava estado, classificação e divergências das notas conferidas, numa leva só. */
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

export class SupabaseInvoiceStore implements InvoiceStore {
  constructor(private readonly rest: SupabaseRest) {}

  async insertNew(invoices: readonly Invoice[]): Promise<string[]> {
    const rows = invoices.map((i) => ({ ...baseRow(i), state: i.state }));
    const inserted = await this.rest.insert<{ access_key: string }>('invoices', rows, {
      onConflict: 'access_key',
      ignoreDuplicates: true,
    });
    return inserted.map((r) => r.access_key);
  }

  async listPendingKeys(): Promise<string[]> {
    const rows = await this.rest.select<{ access_key: string }>('invoices', {
      select: 'access_key',
      filters: { state: 'eq.a_conferir' },
      order: 'access_key',
    });
    return rows.map((r) => r.access_key);
  }

  async saveChecked(invoices: readonly Invoice[], checkedAt: string): Promise<void> {
    if (invoices.length === 0) return;
    await this.rest.upsert(
      'invoices',
      invoices.map((i) => ({ ...baseRow(i), state: i.state, classification: i.classification, checked_at: checkedAt })),
      'access_key',
    );
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
  }
}
