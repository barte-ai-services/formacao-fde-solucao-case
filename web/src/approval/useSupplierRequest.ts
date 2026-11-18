/**
 * #3 Liga o estado do bloco "Pedido ao fornecedor" às chamadas (#16): carrega o pedido, consulta de
 * tempos em tempos enquanto o Claude escreve (AC-2) e traduz cada ação em pendente, feito ou recusado.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError } from "../api/client";
import type { SupplierRequestBlockProps, SupplierRequestPending, SupplierRequestView } from "./SupplierRequestBlock";
import {
  initialSupplierRequestState,
  supplierRequestError,
  supplierRequestReducer,
  viewOf,
  type SupplierRequestPort,
} from "./supplier-request-state";

/** #3/AC-2 Intervalo padrão da consulta enquanto o pedido está sendo escrito; quem monta a gaveta pode trocar. */
export const DEFAULT_POLL_MS = 3000;

export type SupplierRequestHandlers = Omit<SupplierRequestBlockProps, "viewer">;

export function useSupplierRequest(port: SupplierRequestPort, accessKey: string, pollMs: number = DEFAULT_POLL_MS): SupplierRequestHandlers {
  const [state, dispatch] = useReducer(supplierRequestReducer, initialSupplierRequestState);
  const portRef = useRef(port);
  portRef.current = port;
  const live = useRef(true);
  const [attempt, setAttempt] = useState(0);
  // #3/AC-9 Com a consulta parada (5 falhas seguidas), só "Tentar de novo" volta a consultar.
  const polling = state.request?.status === "writing" && !state.loadFailed;

  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    portRef.current
      .load(accessKey, controller.signal)
      .then((request) => {
        if (!controller.signal.aborted) dispatch({ type: "loaded", request });
      })
      // #3/AC-9 Sem conseguir buscar, o bloco mostra a falha de carga; o erro em si não sai daqui.
      .catch(() => {
        if (!controller.signal.aborted) dispatch({ type: "loadFailed" });
      });
    return () => {
      live.current = false;
      controller.abort();
    };
  }, [accessKey, attempt]);

  useEffect(() => {
    if (!polling) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // #3/AC-9 Uma consulta por vez: a próxima só é agendada quando a anterior volta, para uma resposta
    // atrasada nunca passar na frente da falha que para a consulta.
    const schedule = (): void => {
      timer = setTimeout(() => {
        portRef.current
          .load(accessKey, controller.signal)
          .then((request) => {
            if (!controller.signal.aborted) dispatch({ type: "loaded", request });
          })
          // #3/AC-9 Uma consulta que falha conta; com 5 seguidas o estado para a consulta e mostra a falha de carga.
          .catch(() => {
            if (!controller.signal.aborted) dispatch({ type: "pollFailed" });
          })
          .finally(() => {
            if (!controller.signal.aborted) schedule();
          });
      }, pollMs);
    };
    schedule();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [polling, accessKey, pollMs]);

  const reload = useCallback(() => {
    dispatch({ type: "reloadStarted" });
    setAttempt((n) => n + 1);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const request = await portRef.current.load(accessKey, new AbortController().signal);
      if (live.current) dispatch({ type: "loaded", request });
    } catch {
      // #3/AC-4 A releitura que também falha deixa o estado de antes e a mensagem fixa; quem segue vendo vai ter a consulta.
    }
  }, [accessKey]);

  const act = useCallback(async (pending: SupplierRequestPending, call: () => Promise<SupplierRequestView>) => {
    dispatch({ type: "started", pending });
    try {
      const request = await call();
      if (live.current) dispatch({ type: "done", request });
    } catch (reason) {
      if (live.current) dispatch({ type: "failed", error: supplierRequestError(reason) });
      // #3/AC-4 Prazo estourado (status 0): o servidor pode ter concluído, então a tela relê o pedido em vez de manter o de antes.
      if (reason instanceof ApiError && reason.status === 0) await refresh();
    }
  }, [refresh]);

  return {
    request: viewOf(state),
    pending: state.pending,
    error: state.error,
    draftText: state.draftText,
    loadFailed: state.loadFailed,
    reloading: state.reloading,
    onReload: reload,
    onSend: () => void act("send", () => portRef.current.send(accessKey)),
    onResend: () => void act("resend", () => portRef.current.resend(accessKey)),
    onDiscard: () => void act("discard", () => portRef.current.discard(accessKey)),
    onRedo: () => void act("redo", () => portRef.current.redo(accessKey)),
    onSave: () => void act("save", () => portRef.current.saveTemplate(accessKey, state.draftText)),
    onEdit: () => dispatch({ type: "editStarted" }),
    onCancelEdit: () => dispatch({ type: "editCancelled" }),
    onDraftTextChange: (text) => dispatch({ type: "textChanged", text }),
  };
}
