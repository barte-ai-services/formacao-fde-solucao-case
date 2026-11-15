// Caixa de saída gravada numa tabela outbox_* do Supabase: id, chave da nota, payload jsonb (#59, AC-4).
import type { Outbox, Published } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

type OutboxRow = {
  id: number;
  invoice_access_key: string;
  payload: unknown;
  published_at: string;
};

/** #59 Como a mensagem vira JSON e volta, já que Quantity e DockAction carregam objetos do domínio. */
export type OutboxCodec<T extends { readonly invoiceAccessKey: string }> = {
  readonly encode: (message: T) => unknown;
  readonly decode: (invoiceAccessKey: string, payload: unknown) => T;
};

export class SupabaseOutbox<T extends { readonly invoiceAccessKey: string }> implements Outbox<T> {
  constructor(
    private readonly rest: SupabaseRest,
    private readonly table: string,
    private readonly codec: OutboxCodec<T>,
  ) {}

  async publish(message: T): Promise<Published<T>> {
    const [row] = await this.rest.insert<OutboxRow>(
      this.table,
      [{ invoice_access_key: message.invoiceAccessKey, payload: this.codec.encode(message) }],
      { ignoreDuplicates: false },
    );
    if (!row) throw new Error(`outbox: ${this.table} não devolveu a linha gravada`);
    return this.toPublished(row);
  }

  async list(): Promise<Published<T>[]> {
    const rows = await this.rest.select<OutboxRow>(this.table, { order: 'id' });
    return rows.map((row) => this.toPublished(row));
  }

  private toPublished(row: OutboxRow): Published<T> {
    return { ...this.codec.decode(row.invoice_access_key, row.payload), id: row.id, publishedAt: row.published_at };
  }
}
