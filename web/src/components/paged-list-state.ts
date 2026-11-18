// #160 O estado puro de uma lista paginada por cursor: linhas, total e agregados da resposta, fase da busca e aviso de recomeço.
// #160 Sem React nem rede: o hook `usePagedList` traduz cada resposta em uma destas ações; o mapeamento do HTTP é da camada de contrato.
import type { LoadState } from "@barte-ai-services/barte-ui-kit";
import type { Phase } from "./ScrollTable";

/** #160 Um bloco da API paginada (api/README.md): as linhas, o cursor do próximo (nulo no fim), o total e os agregados da lista inteira. */
export interface Block<T extends { key: string }, A> {
  items: T[];
  nextCursor: string | null;
  total: number;
  aggregates: A;
}

/** #160 O cursor que a API recusou (400 `cursor_invalido`): a busca de blocos lança este erro, e quem liga a API o mapeia do HTTP. */
export class InvalidCursorError extends Error {}

/** #160 Quantas linhas de esqueleto cada situação desenha: poucas ao pedir o próximo bloco, uma tela cheia ao recomeçar (wireframe aprovado). */
const SKELETON_NEXT = 3;
const SKELETON_RESTART = 8;

export interface PagedState<T extends { key: string }, A> {
  rows: T[];
  /** #160 O `total` do primeiro bloco (ou da última releitura): não muda com os blocos seguintes (AC-4). */
  total: number;
  /** #160 Os agregados, com a mesma regra do `total`; `undefined` até a primeira resposta. */
  aggregates: A | undefined;
  nextCursor: string | null;
  /** #160 O que está em voo: o primeiro bloco (inclusive depois de trocar o filtro), o próximo, ou nada. */
  load: "first" | "next" | "idle";
  /** #160 Qual busca falhou por último, ou nenhuma. */
  failed: "first" | "next" | null;
  /** #160 A lista recomeçou por `cursor_invalido` (D4): liga o aviso até a próxima troca de filtro. */
  restarted: boolean;
  /** #160 Quantas vezes a lista recomeçou: a tela leva a caixa ao topo a cada incremento. */
  resets: number;
}

export type PagedAction<T extends { key: string }, A> =
  | { type: "start-first"; restart: boolean }
  | { type: "first-loaded"; block: Block<T, A> }
  | { type: "first-failed" }
  | { type: "start-next" }
  | { type: "next-loaded"; block: Block<T, A> }
  | { type: "next-failed" }
  | { type: "removed"; key: string }
  | { type: "totals-refreshed"; total: number; aggregates: A };

export interface PagedView {
  state: LoadState;
  phase: Phase;
  counterBusy: boolean;
  skeletonRows: number;
}

export function initialPagedState<T extends { key: string }, A>(): PagedState<T, A> {
  return { rows: [], total: 0, aggregates: undefined, nextCursor: null, load: "first", failed: null, restarted: false, resets: 0 };
}

export function pagedListReducer<T extends { key: string }, A>(state: PagedState<T, A>, action: PagedAction<T, A>): PagedState<T, A> {
  switch (action.type) {
    case "start-first":
      // #160 A lista esvazia e recarrega do início; os números do topo ficam até a resposta (D4 e o filtro: wireframe aprovado).
      return { ...state, rows: [], nextCursor: null, load: "first", failed: null, restarted: action.restart, resets: state.resets + 1 };
    case "first-loaded":
      return { ...state, rows: action.block.items, total: action.block.total, aggregates: action.block.aggregates, nextCursor: action.block.nextCursor, load: "idle", failed: null };
    case "first-failed":
      return { ...state, load: "idle", failed: "first" };
    case "start-next":
      return { ...state, load: "next", failed: null };
    case "next-loaded": {
      // #160 O total e os agregados ficam os do primeiro bloco (AC-4); só as linhas novas, sem repetir chave, e o cursor andam.
      const seen = new Set(state.rows.map((row) => row.key));
      return { ...state, rows: [...state.rows, ...action.block.items.filter((row) => !seen.has(row.key))], nextCursor: action.block.nextCursor, load: "idle" };
    }
    case "next-failed":
      return { ...state, load: "idle", failed: "next" };
    case "removed": {
      const rows = state.rows.filter((row) => row.key !== action.key);
      // #160 D3: tira a linha e desce o total na hora; os agregados vêm da releitura (`totals-refreshed`).
      return rows.length === state.rows.length ? state : { ...state, rows, total: Math.max(0, state.total - 1) };
    }
    case "totals-refreshed":
      return { ...state, total: action.total, aggregates: action.aggregates };
  }
}

/** #160 O que a tabela e a tela leem do estado: o `LoadState` da tela, a fase da tabela, o contador ocupado e o esqueleto. */
export function viewOf<T extends { key: string }, A>(state: PagedState<T, A>): PagedView {
  const loaded = state.aggregates !== undefined;
  const busy = state.load !== "idle";
  const skeletonRows = state.load === "first" ? SKELETON_RESTART : SKELETON_NEXT;
  const counterBusy = state.load === "first";
  if (state.failed === "first") return { state: "error", phase: "idle", counterBusy, skeletonRows };
  if (!loaded && busy) return { state: "loading", phase: "idle", counterBusy, skeletonRows };
  const empty = loaded && !busy && state.failed === null && state.rows.length === 0 && state.nextCursor === null;
  const phase: Phase = state.failed === "next" ? "error-next" : busy ? "loading-next" : loaded && state.nextCursor === null && !empty ? "end" : "idle";
  return { state: empty ? "empty" : "ready", phase, counterBusy, skeletonRows };
}
