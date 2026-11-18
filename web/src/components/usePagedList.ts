import { useCallback, useEffect, useReducer, useRef } from "react";
import type { LoadState } from "@barte-ai-services/barte-ui-kit";
import { InvalidCursorError, initialPagedState, pagedListReducer, viewOf, type Block } from "./paged-list-state";
import type { Phase } from "./ScrollTable";

/** #160 A busca de um bloco: o cursor do bloco (nulo no primeiro) e o sinal que cancela o pedido. Lança `InvalidCursorError` se a API recusa o cursor. */
export type FetchBlock<T extends { key: string }, A> = (cursor: string | null, signal: AbortSignal) => Promise<Block<T, A>>;

export interface PagedList<T extends { key: string }, A> {
  /** #160 O `LoadState` da tela (`Screen`): carregando só até o primeiro bloco; trocar o filtro não volta a `loading`. */
  state: LoadState;
  rows: T[];
  /** #160 O `total` da resposta: o contador e o rodapé da tabela dizem este número, nunca `rows.length`. */
  total: number;
  /** #160 Os agregados da resposta, para os números do topo; `undefined` até o primeiro bloco chegar. */
  aggregates: A | undefined;
  /** #160 As props da `ScrollTable`, tal qual. */
  phase: Phase;
  skeletonRows: number;
  counterBusy: boolean;
  restarted: boolean;
  /** #160 Muda a cada recomeço da lista; vai em `resetKey` da `ScrollTable`, que leva a caixa ao topo. */
  scrollKey: number;
  /** #160 `onNearEnd` da `ScrollTable`: pede o próximo bloco, uma vez por vez. */
  loadNext: () => void;
  /** #160 `onRetry` da `ScrollTable`: repete o MESMO cursor do bloco que falhou. */
  retryBlock: () => void;
  /** #160 `onRetry` do `Screen`: recarrega do primeiro bloco, depois que ele mesmo falhou. */
  retry: () => void;
  /** #160 D3: depois de decidir uma nota na gaveta, tira a linha e relê o total e os agregados, sem voltar ao início. */
  remove: (key: string) => void;
}

/**
 * #160 O estado de uma lista paginada por cursor, genérico sobre a busca de um bloco. Carrega o primeiro bloco ao montar e a cada
 * troca de `paramsKey` (filtro, dia, destino): a lista esvazia, recarrega do início e a resposta atrasada da chave anterior é
 * descartada. `total` e `aggregates` vêm da resposta do primeiro bloco e não andam com os seguintes (AC-4). O erro em si nunca
 * sai do hook: a tela só recebe a fase (`error-next`), e o detalhe é do contrato.
 */
export function usePagedList<T extends { key: string }, A>(fetchBlock: FetchBlock<T, A>, paramsKey: string): PagedList<T, A> {
  const fetchRef = useRef(fetchBlock);
  const [state, dispatch] = useReducer(pagedListReducer<T, A>, initialPagedState<T, A>());
  const stateRef = useRef(state);
  /** #160 O pedido da geração atual da lista (do primeiro bloco ao fim); trocar o filtro o aborta. */
  const controllerRef = useRef<AbortController | null>(null);
  /** #160 Um bloco já foi pedido e a tela ainda não desenhou a fase: barra o pedido duplicado do observador. */
  const nextBusy = useRef(false);
  const restartedRef = useRef(false);
  const refreshSeq = useRef(0);
  // #160 Atualizados depois de cada desenho, não durante ele.
  useEffect(() => {
    fetchRef.current = fetchBlock;
    stateRef.current = state;
    if (state.load !== "next") nextBusy.current = false;
  });

  const begin = useCallback((restart: boolean): void => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    nextBusy.current = false;
    restartedRef.current = restart;
    refreshSeq.current += 1;
    dispatch({ type: "start-first", restart });
    fetchRef
      .current(null, controller.signal)
      .then((block) => {
        if (!controller.signal.aborted) dispatch({ type: "first-loaded", block });
      })
      .catch(() => {
        if (!controller.signal.aborted) dispatch({ type: "first-failed" });
      });
  }, []);

  useEffect(() => {
    begin(false);
    return () => controllerRef.current?.abort();
  }, [paramsKey, begin]);

  const runNext = useCallback(
    (cursor: string): void => {
      const controller = controllerRef.current;
      if (!controller || nextBusy.current) return;
      nextBusy.current = true;
      dispatch({ type: "start-next" });
      fetchRef
        .current(cursor, controller.signal)
        .then((block) => {
          if (!controller.signal.aborted) dispatch({ type: "next-loaded", block });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          // #160 D4: o cursor recusado recomeça do primeiro bloco, uma vez; a segunda recusa vira erro de bloco.
          if (error instanceof InvalidCursorError && !restartedRef.current) begin(true);
          else dispatch({ type: "next-failed" });
        });
    },
    [begin],
  );

  const loadNext = useCallback((): void => {
    const s = stateRef.current;
    if (s.load === "idle" && s.failed === null && s.nextCursor !== null) runNext(s.nextCursor);
  }, [runNext]);

  const retryBlock = useCallback((): void => {
    const s = stateRef.current;
    if (s.failed === "next" && s.nextCursor !== null) runNext(s.nextCursor);
  }, [runNext]);

  const remove = useCallback((key: string): void => {
    const controller = controllerRef.current;
    if (!controller || !stateRef.current.rows.some((row) => row.key === key)) return;
    dispatch({ type: "removed", key });
    const seq = ++refreshSeq.current;
    // #160 D3: relê só o total e os agregados pelo primeiro bloco, sem trocar as linhas; só a releitura mais nova vale.
    fetchRef
      .current(null, controller.signal)
      .then((block) => {
        if (!controller.signal.aborted && seq === refreshSeq.current) dispatch({ type: "totals-refreshed", total: block.total, aggregates: block.aggregates });
      })
      .catch(() => {
        // #160 Sem a releitura, fica o ajuste local do total; os agregados se acertam na próxima carga.
      });
  }, []);

  const retry = useCallback((): void => begin(false), [begin]);

  return { ...viewOf(state), rows: state.rows, total: state.total, aggregates: state.aggregates, restarted: state.restarted, scrollKey: state.resets, loadNext, retryBlock, retry, remove };
}
