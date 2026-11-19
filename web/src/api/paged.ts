// #160 O fio das listas paginadas por cursor (api/README.md, "Listas paginadas por cursor"): o pedido de um bloco e a resposta em `Block`.
import { InvalidCursorError, type Block } from "../components/paged-list-state";
import { ApiError, apiGet } from "./client";

/** #160 O tamanho do bloco: o padrão da API (30), no meio da faixa de 25 a 50, para o scroll pedir o próximo antes do fim. */
export const PAGE_LIMIT = 30;

/** #160 A resposta paginada de uma lista: a página, o cursor da próxima (nulo na última), a contagem da lista inteira e os agregados dela. */
export interface PageDto<I, A> {
  items: I[];
  nextCursor: string | null;
  total: number;
  aggregates: A;
}

/**
 * #160 Pede um bloco da lista. `limite` entra sempre (é ele que liga o modo paginado); `cursor` só do segundo bloco em diante; `filters` são
 * os outros parâmetros da lista. O 400 `cursor_invalido` vira `InvalidCursorError`; qualquer outro erro sobe como `ApiError`, e o corpo
 * da resposta não vai além do código (a tela mostra a faixa do wireframe, nunca o texto do erro).
 */
export async function getPage<D extends PageDto<object, unknown>>(path: string, filters: [name: string, value: string][], cursor: string | null, signal: AbortSignal): Promise<D> {
  const query = new URLSearchParams({ limite: String(PAGE_LIMIT) }); // ADR-006
  if (cursor !== null) query.set("cursor", cursor);
  for (const [name, value] of filters) query.set(name, value);
  try {
    return await apiGet<D>(`${path}?${query.toString()}`, { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 400 && error.code === "cursor_invalido") throw new InvalidCursorError("cursor_invalido"); // ADR-006
    throw error;
  }
}

/** #160 A página da API como bloco do `usePagedList`: cada linha ganha a `key` que o hook usa para não repetir nem remover a errada. */
export function blockOf<I extends object, A>(page: PageDto<I, A>, keyOf: (item: I) => string): Block<I & { key: string }, A> {
  return { items: page.items.map((item) => ({ ...item, key: keyOf(item) })), nextCursor: page.nextCursor, total: page.total, aggregates: page.aggregates };
}
