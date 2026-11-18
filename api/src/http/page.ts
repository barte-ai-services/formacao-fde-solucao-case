/** #159 Paginação por cursor das listas (fila, hoje, duplicadas, doca). Módulo puro: recebe a lista, a ordem dela e o pedido, e devolve a página. Nada aqui lê banco nem sabe o que é uma fila. */

/**
 * O limite padrão é 30: o meio da faixa de 25 a 50. Enche uma tela de tabela com folga para o scroll
 * infinito pedir a próxima página antes de a pessoa chegar ao fim, e a resposta cabe no Worker sem custo.
 */
export const DEFAULT_LIMIT = 30;
export const MIN_LIMIT = 25;
export const MAX_LIMIT = 50;

/** A tupla de ordenação de um item: a ordem crescente da tupla é a ordem da lista. */
export type Key = readonly (string | number)[];

/**
 * A ordem total e estável de uma lista. `key` devolve a tupla do item, que termina numa chave única
 * (a chave de acesso da nota) para o desempate; campo que ordena do maior para o menor entra negado.
 * `shape` diz o tipo de cada posição da tupla, para recusar um cursor de forma errada. `list` nomeia
 * a lista, e o cursor de uma não serve noutra. `compare` é a comparação das tuplas; sem ela, posição a
 * posição, números pelo valor e textos pela ordem do código (determinística, sem locale).
 */
export type Ordering<T> = {
  readonly list: string;
  readonly shape: readonly ('string' | 'number')[];
  readonly key: (item: T) => Key;
  readonly compare?: (a: Key, b: Key) => number;
};

export type Page<T> = { items: T[]; nextCursor: string | null; total: number };

export type PageQuery =
  | { kind: 'whole' }
  | { kind: 'page'; cursor: string | null; limit: number }
  | { kind: 'invalid'; response: Response };

const CURSOR_VERSION = 1;

/** #159/AC-3 O pedido recusado diz só o código: nunca o valor recebido nem a causa. */
const badRequest = (code: 'cursor_invalido' | 'limite_invalido') => Response.json({ error: code }, { status: 400 });

export const invalidCursor = (): Response => badRequest('cursor_invalido');

/**
 * Lê `cursor` e `limite` da query. Sem nenhum dos dois, a lista inteira, como antes da #159. Com um
 * deles, a página: `limite` ausente vale 30, `cursor` ausente é a primeira página. `limite` que não
 * seja um inteiro decimal de 25 a 50 é 400 `limite_invalido`. O cursor só é conferido em `pageOf`.
 */
export function readPageQuery(params: URLSearchParams): PageQuery {
  const rawLimit = params.get('limite');
  const cursor = params.get('cursor');
  if (rawLimit === null && cursor === null) return { kind: 'whole' };
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!(limit >= MIN_LIMIT && limit <= MAX_LIMIT)) return { kind: 'invalid', response: badRequest('limite_invalido') };
  }
  return { kind: 'page', cursor, limit };
}

function compareKeys(a: Key, b: Key): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] as string | number;
    const y = b[i] as string | number;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

const compareBy = <T>(ordering: Ordering<T>) => ordering.compare ?? compareKeys;

/** A lista na ordem da lista, sem mexer na recebida. Vale nos dois modos: inteira e paginada. */
export function sortedBy<T>(items: readonly T[], ordering: Ordering<T>): T[] {
  const compare = compareBy(ordering);
  return [...items].sort((a, b) => compare(ordering.key(a), ordering.key(b)));
}

function encodeCursor(list: string, key: Key): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: CURSOR_VERSION, l: list, k: key }));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** #159/AC-3 Nulo para qualquer cursor que não seja um que esta lista tenha emitido: sem dizer por quê. */
function decodeCursor<T>(cursor: string, ordering: Ordering<T>): Key | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (typeof body !== 'object' || body === null) return null;
    const { v, l, k } = body as { v?: unknown; l?: unknown; k?: unknown };
    if (v !== CURSOR_VERSION || l !== ordering.list || !Array.isArray(k)) return null;
    if (k.length !== ordering.shape.length) return null;
    if (!k.every((part, i) => typeof part === ordering.shape[i] && (typeof part !== 'number' || Number.isFinite(part)))) return null;
    return k as Key;
  } catch {
    return null;
  }
}

/**
 * A página que vem estritamente depois da tupla do cursor (a primeira, sem cursor), da lista já
 * ordenada por `sortedBy`. O cursor guarda a tupla do último item entregue, não uma posição: um item
 * que sai da lista entre duas páginas não faz outro pular nem repetir. `total` é o da lista inteira.
 * Nulo quando o cursor é inválido, para o handler responder 400 `cursor_invalido`.
 */
export function pageOf<T>(
  ordering: Ordering<T>,
  ordered: readonly T[],
  query: { cursor: string | null; limit: number },
): Page<T> | null {
  const compare = compareBy(ordering);
  let start = 0;
  if (query.cursor !== null) {
    const after = decodeCursor(query.cursor, ordering);
    if (after === null) return null;
    start = ordered.findIndex((item) => compare(ordering.key(item), after) > 0);
    if (start === -1) start = ordered.length;
  }
  const items = ordered.slice(start, start + query.limit);
  const last = items.at(-1);
  const more = start + query.limit < ordered.length;
  return {
    items,
    nextCursor: more && last !== undefined ? encodeCursor(ordering.list, ordering.key(last)) : null,
    total: ordered.length,
  };
}
