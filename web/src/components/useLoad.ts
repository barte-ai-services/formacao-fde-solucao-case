import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadState } from "@barte-ai-services/barte-ui-kit";

export interface Load<T> {
  /** O estado que o `LoadFeedback` desenha. */
  state: LoadState;
  /** O que a promessa entregou, em `ready` e em `empty`. */
  data: T | undefined;
  /** O motivo da falha, em `error`. */
  error: unknown;
  /** Carrega de novo: é o `onRetry` do estado de erro. */
  retry: () => void;
}

/**
 * Carrega uma vez ao montar e dá o `LoadState` da carga. `isEmpty` diz quando o resultado conta
 * como vazio (uma fila sem proposta, por exemplo). Uma resposta que chega depois da tela sair, ou
 * depois de um `retry`, é descartada; o `signal` cancela o pedido que ficou para trás.
 */
export function useLoad<T>(
  load: (signal: AbortSignal) => Promise<T>,
  isEmpty: (data: T) => boolean = () => false,
): Load<T> {
  const loadRef = useRef(load);
  const emptyRef = useRef(isEmpty);
  loadRef.current = load;
  emptyRef.current = isEmpty;

  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Omit<Load<T>, "retry">>({ state: "loading", data: undefined, error: undefined });

  useEffect(() => {
    const controller = new AbortController();
    setResult({ state: "loading", data: undefined, error: undefined });
    loadRef
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult({ state: emptyRef.current(data) ? "empty" : "ready", data, error: undefined });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setResult({ state: "error", data: undefined, error });
      });
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...result, retry };
}
