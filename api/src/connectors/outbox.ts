// Caixa de saída gravada numa tabela outbox_* do Supabase: id, chave da nota, payload jsonb (#59, AC-4).
import { isInteger, isString, parseOne, parseRows, shaped, type Guard, type Shape } from './guards.js';
import type { Outbox, Published } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

type OutboxRow<E> = {
  id: number;
  invoice_access_key: string;
  payload: E;
  published_at: string;
};

/**
 * #59 Como a mensagem vira JSON e volta, já que Quantity e DockAction carregam objetos do domínio.
 * O guard confere o payload que volta do banco antes do decode.
 */
export type OutboxCodec<T extends { readonly invoiceAccessKey: string }, E> = {
  readonly encode: (message: T) => E;
  readonly isEncoded: Guard<E>;
  readonly decode: (invoiceAccessKey: string, payload: E) => T;
};

/** #59 JSON com as chaves em ordem, para que a mesma mensagem dê sempre o mesmo hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** #59 A chave de idempotência: a nota mais o sha256 do payload canônico. */
export async function idempotencyKey(invoiceAccessKey: string, payload: unknown): Promise<string> {
  return `${invoiceAccessKey}:${await sha256Hex(canonicalJson(payload))}`;
}

export class SupabaseOutbox<T extends { readonly invoiceAccessKey: string }, E> implements Outbox<T> {
  private readonly isRow: Guard<OutboxRow<E>>;

  constructor(
    private readonly rest: SupabaseRest,
    private readonly table: string,
    private readonly codec: OutboxCodec<T, E>,
  ) {
    const shape = {
      id: isInteger,
      invoice_access_key: isString,
      payload: codec.isEncoded,
      published_at: isString,
    } satisfies Shape<OutboxRow<E>>;
    this.isRow = shaped<OutboxRow<E>>(shape);
  }

  /** #59 Publicar a mesma mensagem de novo devolve a linha que já existe, sem gravar outra. */
  async publish(message: T): Promise<Published<T>> {
    const payload = this.codec.encode(message);
    const key = await idempotencyKey(message.invoiceAccessKey, payload);
    const [inserted] = await this.rest.insert(
      this.table,
      [{ invoice_access_key: message.invoiceAccessKey, payload, idempotency_key: key }],
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    );
    const row =
      inserted ?? (await this.rest.select(this.table, { filters: { idempotency_key: `eq.${key}` } }))[0];
    return this.toPublished(parseOne(row, this.isRow, this.table));
  }

  async list(): Promise<Published<T>[]> {
    const rows = parseRows(await this.rest.select(this.table, { order: 'id' }), this.isRow, this.table);
    return rows.map((row) => this.toPublished(row));
  }

  private toPublished(row: OutboxRow<E>): Published<T> {
    return { ...this.codec.decode(row.invoice_access_key, row.payload), id: row.id, publishedAt: row.published_at };
  }
}
