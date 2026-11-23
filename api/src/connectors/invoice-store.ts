// Gravação das notas capturadas e do resultado da conferência (invoices, divergences) (#59, AC-5).
import type { Invoice } from '../domain/index.js';
import { isString, nullable, optional, parseRows, shaped, type Shape } from './guards.js';
import type { SupabaseRest } from './supabase-rest.js';

export interface InvoiceStore {
  /** #59 Regra 1: grava as notas novas e ignora a chave que já existe. Devolve as chaves gravadas agora. */
  insertNew(invoices: readonly Invoice[]): Promise<string[]>;
  /** #59 As notas ainda a conferir, cada uma com o motivo já guardado da última falha (#356 AC-4: na mesma requisição, sem leitura a mais). */
  listPendingKeys(): Promise<PendingKey[]>;
  /** #59 Grava divergências e depois estado e classificação das notas conferidas (REL-3). */
  saveChecked(invoices: readonly Invoice[], checkedAt: string): Promise<void>;
  /** #56 Marca a nota que quebrou na conferência com o motivo; ela segue a conferir. */
  markCheckFailed(failures: readonly CheckFailure[]): Promise<void>;
}

/** #59 Uma nota a conferir e o motivo que a falha de uma rodada anterior já deixou nela (null: nunca marcada). */
export type PendingKey = { readonly accessKey: string; readonly checkError: string | null };

/**
 * #56 Uma nota que a conferência não conseguiu conferir, e por quê. `storedReason` é o motivo que a nota já guarda
 * (#356 AC-4): igual a `reason`, marcar de novo é um update que não muda nada.
 */
export type CheckFailure = { readonly accessKey: string; readonly reason: string; readonly storedReason?: string | null };

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
// #356 AC-4 check_error é null enquanto a nota nunca quebrou; uma coluna ausente (o PostgREST falso) vale null.
type PendingRow = { access_key: string; check_error?: string | null | undefined };
const isPendingRow = shaped<PendingRow>({ access_key: isString, check_error: optional(nullable(isString)) } satisfies Shape<PendingRow>);

export class SupabaseInvoiceStore implements InvoiceStore {
  constructor(private readonly rest: SupabaseRest) {}

  async insertNew(invoices: readonly Invoice[]): Promise<string[]> {
    const rows = invoices.map((i) => ({ ...baseRow(i), state: i.state }));
    const inserted = await this.rest.insert('invoices', rows, { onConflict: 'access_key', ignoreDuplicates: true });
    return parseRows(inserted, isInvoiceKeyRow, 'invoices').map((r) => r.access_key);
  }

  async listPendingKeys(): Promise<PendingKey[]> {
    const rows = await this.rest.select('invoices', {
      select: 'access_key,check_error',
      filters: { state: 'eq.a_conferir' },
      order: 'access_key',
    });
    return parseRows(rows, isPendingRow, 'invoices').map((r) => ({ accessKey: r.access_key, checkError: r.check_error ?? null }));
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
      invoices.map((i) => ({
        ...baseRow(i),
        state: i.state,
        classification: i.classification,
        checked_at: checkedAt,
        check_error: null, // #56 conferida, o motivo de uma rodada anterior sai
      })),
      'access_key',
    );
  }

  /** #56 Uma escrita por nota: são poucas, e cada uma leva o motivo dela. */
  async markCheckFailed(failures: readonly CheckFailure[]): Promise<void> {
    for (const { accessKey, reason } of failures) {
      await this.rest.update('invoices', { access_key: `eq.${accessKey}` }, { check_error: reason });
    }
  }
}
