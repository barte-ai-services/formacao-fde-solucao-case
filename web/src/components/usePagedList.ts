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
  /** #160 `onRetry` da `ScrollTable`: repete o MESMO cursor do bloco que falhou; se o cursor foi recusado (D4), recomeça do primeiro bloco. */
  retryBlock: () => void;
  /** #160 `onRetry` do `Screen`: recarrega do primeiro bloco, depois que ele mesmo falhou. */
  retry: () => void;
  /** #160 D3: depois de decidir uma nota na gaveta, tira a linha e relê o total e os agregados, sem voltar ao início. */
  remove: (key: string) => void;
  /**
   * #160 D3 onde o servidor mantém a nota decidida: relê em segundo plano e troca as linhas no lugar (pela `key`), sem esvaziar a lista
   * nem mexer na rolagem; o `total` e os agregados vêm da releitura. Regra de parada: lê enquanto houver cursor e (ainda faltarem linhas
   * para cobrir as da tela OU a `key` decidida não tiver voltado), com teto de um bloco além dos já carregados; se a chave não voltou
   * nem assim (sumiu do servidor), a linha fica como estava. Linha nova do servidor que não está na tela não entra. Vale só a releitura
   * mais nova e só na geração atual da lista: trocar o filtro, recomeçar ou decidir outra nota depois a descarta.
   */
  refresh: (decidedKey: string) => void;
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
  /** #160 D4: o recomeço por cursor recusado já foi gasto nesta geração; volta a `false` quando um bloco seguinte chega (o cursor andou) ou no filtro novo. */
  const restartedRef = useRef(false);
  /** #160 D4: o último erro de bloco foi o cursor recusado: repetir o cursor nunca resolve, o "Tentar de novo" recomeça. */
  const cursorRefusedRef = useRef(false);
  const refreshSeq = useRef(0);
  /** #160 D3: quantos blocos a geração atual já carregou; o teto da releitura é este número mais um. */
  const loadedBlocks = useRef(0);
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
    cursorRefusedRef.current = false;
    loadedBlocks.current = 0;
    refreshSeq.current += 1;
    dispatch({ type: "start-first", restart });
    fetchRef
      .current(null, controller.signal)
      .then((block) => {
        if (controller.signal.aborted) return;
        loadedBlocks.current = 1;
        dispatch({ type: "first-loaded", block });
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
      cursorRefusedRef.current = false;
      dispatch({ type: "start-next" });
      fetchRef
        .current(cursor, controller.signal)
        .then((block) => {
          if (controller.signal.aborted) return;
          restartedRef.current = false;
          loadedBlocks.current += 1;
          dispatch({ type: "next-loaded", block });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          // #160 D4: o cursor recusado recomeça do primeiro bloco, uma vez por geração; a segunda recusa, sem bloco seguinte no meio, vira erro de bloco.
          if (error instanceof InvalidCursorError && !restartedRef.current) begin(true);
          else {
            cursorRefusedRef.current = error instanceof InvalidCursorError;
            dispatch({ type: "next-failed" });
          }
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
    if (s.failed !== "next" || s.nextCursor === null) return;
    // #160 D4: o cursor que a API recusou ela recusa sempre; repetir seria um botão que nunca funciona.
    if (cursorRefusedRef.current) begin(true);
    else runNext(s.nextCursor);
  }, [runNext, begin]);

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

  const refresh = useCallback((decidedKey: string): void => {
    const controller = controllerRef.current;
    if (!controller || stateRef.current.aggregates === undefined) return;
    const seq = ++refreshSeq.current;
    const wanted = stateRef.current.rows.length;
    const ceiling = loadedBlocks.current + 1;
    void (async () => {
      const fresh: T[] = [];
      let first: Block<T, A> | undefined;
      let cursor: string | null = null;
      let read = 0;
      try {
        do {
          const block: Block<T, A> = await fetchRef.current(cursor, controller.signal);
          if (controller.signal.aborted || seq !== refreshSeq.current) return;
          first ??= block;
          fresh.push(...block.items);
          cursor = block.nextCursor;
          read += 1;
        } while (cursor !== null && read < ceiling && (fresh.length < wanted || !fresh.some((row) => row.key === decidedKey)));
      } catch {
        // #160 Sem a releitura ficam as linhas e os números de antes; a próxima carga os acerta.
        return;
      }
      if (first) dispatch({ type: "rows-refreshed", rows: fresh, total: first.total, aggregates: first.aggregates });
    })();
  }, []);

  const retry = useCallback((): void => begin(false), [begin]);

  return { ...viewOf(state), rows: state.rows, total: state.total, aggregates: state.aggregates, restarted: state.restarted, scrollKey: state.resets, loadNext, retryBlock, retry, remove, refresh };
}
