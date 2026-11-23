// Ferramentas comuns dos casos do gerador (#349): datas, sorteio de fornecedor, destino, valor e itens da ordem.
import type { Classification } from '../domain/index.js';
import { BLOCKED_SUPPLIER, DISTRIBUTION_CENTERS, PRODUCTS, STORES, SUPPLIERS, type DemoProduct } from './catalog.js';
import type { KeyAllocator } from './access-key.js';
import type { Rng } from './prng.js';
import type { DemoItem, NoteInput, RowSink } from './rows.js';

/** L = loja (até R$ 4 mil), C = CD até R$ 20 mil, CB = CD acima de R$ 20 mil, H = acima de R$ 100 mil. (#349) */
export type Size = 'L' | 'C' | 'CB' | 'H';

export type CaseEnv = {
  readonly rng: Rng;
  /** Sorteia os textos livres sem olhar o tipo do caso, para o texto nunca denunciar a exceção. (#349) */
  readonly textRng: Rng;
  readonly today: string;
  /** O número de sequência da nota: todo id e todo código de chave dela sai dele. (#349) */
  readonly n: number;
  readonly keys: KeyAllocator;
  readonly sink: RowSink;
};

export type CaseOutcome = {
  readonly key: string;
  readonly supplierId: string;
  readonly totalCents: number;
  readonly classification: Classification;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export const pad = (value: number, width: number): string => String(value).padStart(width, '0');

export const orderIdOf = (env: CaseEnv): string => `OC-DM-${env.n}`;
export const receiptIdOf = (env: CaseEnv): string => `RC-DM-${env.n}`;
export const paymentIdOf = (env: CaseEnv): string => `PG-DM-${env.n}`;
export const noteIdOf = (env: CaseEnv): string => `DM-${pad(env.n, 5)}`;

const RECEIPT_NOTES = [
  '', '', '', '',
  'Recebido pelo app',
  'Conferência concluída',
  'Recebido a pedido do comercial',
  'Conferência feita pelo turno da noite',
  'Volume conferido por amostragem',
  'Entrega fora da janela agendada',
  'Motorista aguardou na doca',
];
const LOCK_REASONS = ['Pendência com compras', 'Aguarda liberação', 'Em revisão'];

export const receiptNote = (env: CaseEnv): string => env.textRng.pick(RECEIPT_NOTES);
export const lockReason = (env: CaseEnv): string => env.textRng.pick(LOCK_REASONS);

export function pickSupplier(rng: Rng, allowed?: (supplierId: string) => boolean): string {
  const options = SUPPLIERS.filter((s) => s.id !== BLOCKED_SUPPLIER && (allowed?.(s.id) ?? true)).map((s) => s.id);
  return rng.pick(options);
}

export const pickStore = (rng: Rng, size: Size): string => rng.pick(size === 'L' ? STORES : DISTRIBUTION_CENTERS);

const RANGES: Readonly<Record<Size, readonly [number, number]>> = {
  L: [450, 3900],
  C: [6200, 18500],
  CB: [24000, 72000],
  H: [104000, 158000],
};

/** O valor-alvo da nota, em centavos. (#349) */
export function targetCents(rng: Rng, size: Size): number {
  const [low, high] = RANGES[size];
  return Math.round(rng.float(low, high) * 100);
}

export const productsOf = (supplierId: string): DemoProduct[] => PRODUCTS.filter((p) => p.supplierId === supplierId);

export function itemOf(product: DemoProduct, quantity: number): DemoItem {
  return {
    sku: product.sku,
    code: product.supplierCode,
    description: product.description,
    quantity,
    unit: 'UN',
    priceCents: product.priceCents,
  };
}

/** Itens da ordem: `count` produtos do fornecedor, pesos sorteados, quantidade em múltiplos de `multiple`. (#349) */
export function orderItems(rng: Rng, supplierId: string, valueCents: number, count = 3, multiple = 4): DemoItem[] {
  const products = rng.sample(productsOf(supplierId), count);
  const weights = products.map(() => rng.float(0.6, 1.4));
  const sum = weights.reduce((a, b) => a + b, 0);
  return products.map((product, i) => {
    const share = (valueCents * (weights[i] ?? 1)) / sum;
    return itemOf(product, Math.max(multiple, Math.round(share / product.priceCents / multiple) * multiple));
  });
}

export type NoteSpec = {
  readonly supplierId: string;
  readonly store: string;
  readonly issuedOn: string;
  readonly items: readonly DemoItem[];
  readonly orderId: string | null;
  readonly channel?: string;
  /** O código da chave: a nota do lote usa `n * 2`, a nota lançada de fundo usa `n * 2 + 1`. (#349) */
  readonly slot: 0 | 1;
  readonly number?: number;
};

export function newNote(env: CaseEnv, spec: NoteSpec): NoteInput {
  const supplier = SUPPLIERS.find((s) => s.id === spec.supplierId);
  if (!supplier) throw new RangeError(`fornecedor fora do catálogo: ${spec.supplierId}`);
  const number = spec.number ?? env.rng.int(10_000, 900_000);
  const key = env.keys.allocate(
    { cnpjDigits: supplier.cnpjDigits, issuedOn: spec.issuedOn, series: 1, number },
    env.n * 2 + spec.slot,
  );
  return {
    key,
    noteId: spec.slot === 0 ? noteIdOf(env) : null,
    number,
    supplierId: spec.supplierId,
    store: spec.store,
    issuedOn: spec.issuedOn,
    orderId: spec.orderId,
    channel: spec.channel ?? 'SEFAZ',
    items: spec.items,
  };
}

/** A data do recebimento: o dia seguinte à emissão, sem passar de hoje. (#349) */
export const receivedOn = (env: CaseEnv, issuedOn: string): string => {
  const next = addDays(issuedOn, 1);
  return next > env.today ? env.today : next;
};
