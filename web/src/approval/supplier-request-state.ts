/**
 * #3 O estado do bloco "Pedido ao fornecedor": a conta pura das transições do wireframe
 * (artifacts/wireframe-pedido-ao-fornecedor/index.html, seção 3). Sem rede e sem React: quem busca e quem
 * desenha são useSupplierRequest e SupplierRequestBlock (#16).
 */
import { ApiError } from "../api/client";
import { texts } from "../texts";
import type { SupplierRequestPending, SupplierRequestView } from "./SupplierRequestBlock";

/**
 * #17 As chamadas que o estado precisa, na visão que o bloco desenha; cada ação devolve o pedido como ficou. Quem a implementa
 * é web/src/api/supplier-request.ts, cujo `SupplierRequestDto` cabe nesta visão.
 */
export interface SupplierRequestPort {
  load: (accessKey: string, signal: AbortSignal) => Promise<SupplierRequestView | null>;
  send: (accessKey: string) => Promise<SupplierRequestView>;
  resend: (accessKey: string) => Promise<SupplierRequestView>;
  discard: (accessKey: string) => Promise<SupplierRequestView>;
  redo: (accessKey: string) => Promise<SupplierRequestView>;
  /** #17/AC-6 Salva o molde do texto (com os `{{chave}}`); o servidor reconfere os números. */
  saveTemplate: (accessKey: string, template: string) => Promise<SupplierRequestView>;
}

export interface SupplierRequestState {
  /** #3/AC-1 O pedido guardado; nulo, o bloco não existe. A edição é à parte: o `editing` do bloco sai de `editing`. */
  request: SupplierRequestView | null;
  editing: boolean;
  /** #17/AC-6 O molde em edição, com os `{{chave}}` dos números travados: é o que o PATCH reenvia. */
  draftText: string;
  pending?: SupplierRequestPending;
  /** #3 A mensagem por status; nunca o texto do erro nem o corpo da resposta. */
  error?: string;
  /** #3/AC-9 A carga falhou (inicial, ou consulta que falhou 5 vezes seguidas): o bloco dá lugar ao alerta com "Tentar de novo". */
  loadFailed: boolean;
  /** #3/AC-9 "Tentar de novo" em andamento ("Carregando…"). */
  reloading: boolean;
  /** #3/AC-9 Consultas seguidas que falharam enquanto o pedido é escrito; zera quando uma dá certo. */
  pollFailures: number;
}

export const initialSupplierRequestState: SupplierRequestState = {
  request: null,
  editing: false,
  draftText: "",
  loadFailed: false,
  reloading: false,
  pollFailures: 0,
};

/** #3/AC-9 Com 5 falhas seguidas a consulta para e o bloco mostra a falha de carga. */
export const MAX_POLL_FAILURES = 5;

export type SupplierRequestEvent =
  | { type: "loaded"; request: SupplierRequestView | null }
  | { type: "loadFailed" }
  | { type: "pollFailed" }
  | { type: "reloadStarted" }
  | { type: "started"; pending: SupplierRequestPending }
  | { type: "done"; request: SupplierRequestView }
  | { type: "failed"; error: string }
  | { type: "editStarted" }
  | { type: "editCancelled" }
  | { type: "textChanged"; text: string };

export function supplierRequestReducer(state: SupplierRequestState, event: SupplierRequestEvent): SupplierRequestState {
  switch (event.type) {
    case "loaded":
      // #3/AC-2 A busca periódica não pisa numa ação em andamento nem numa edição aberta.
      return state.pending || state.editing
        ? state
        : { ...state, request: event.request, loadFailed: false, reloading: false, pollFailures: 0 };
    case "loadFailed":
      // #3/AC-9 A carga que falha não vira "sem pedido": o bloco mostra a falha, sem o texto do erro.
      return { ...state, loadFailed: true, reloading: false };
    case "pollFailed": {
      const pollFailures = state.pollFailures + 1;
      return pollFailures >= MAX_POLL_FAILURES ? { ...state, pollFailures, loadFailed: true, reloading: false } : { ...state, pollFailures };
    }
    case "reloadStarted":
      return { ...state, reloading: true };
    case "started":
      return { ...state, pending: event.pending, error: undefined };
    case "done":
      return { ...state, request: event.request, editing: false, pending: undefined, error: undefined };
    case "failed":
      // #3/AC-6 O bloco volta ao estado de antes; na edição, ela continua aberta com o texto digitado.
      return { ...state, pending: undefined, error: event.error };
    case "editStarted":
      return state.request?.status === "draft" && !state.pending
        ? { ...state, editing: true, draftText: state.request.email.template, error: undefined }
        : state;
    case "editCancelled":
      return { ...state, editing: false, error: undefined };
    case "textChanged":
      return { ...state, draftText: event.text };
  }
}

/** #3/AC-6 O que o bloco desenha: um rascunho em edição vira o estado `editing`. */
export function viewOf(state: SupplierRequestState): SupplierRequestView | null {
  const { request } = state;
  return state.editing && request?.status === "draft" ? { ...request, status: "editing" } : request;
}

/** #3 A mensagem em português por status da recusa (403, 409, 422, outro); o texto do erro não sai daqui. */
export function supplierRequestError(reason: unknown): string {
  const errors = texts.supplierRequest.errors;
  if (reason instanceof ApiError) {
    if (reason.status === 403) return errors.forbidden;
    if (reason.status === 409) return errors.conflict;
    if (reason.status === 422) return errors.unprocessable;
    // #3/AC-4 Status 0: o prazo estourou ou a rede caiu; o servidor pode ter concluído, e a tela relê o pedido.
    if (reason.status === 0) return errors.timeout;
  }
  return errors.other;
}
