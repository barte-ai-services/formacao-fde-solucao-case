import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { texts } from "../texts";
import type { SupplierRequestView } from "./SupplierRequestBlock";
import { initialSupplierRequestState, MAX_POLL_FAILURES, supplierRequestError, supplierRequestReducer, viewOf, type SupplierRequestState } from "./supplier-request-state";

// #156 A conta pura do estado do bloco "Pedido ao fornecedor" (#156): sem rede e sem tela.

const email = { to: "fiscal@higienetotal.test", dueOn: "2026-11-18", subject: "NF 20046 · devolução", body: "Texto original", template: "Texto {{valor}} original" };
const draft: SupplierRequestView = { status: "draft", email };
const withRequest = (request: SupplierRequestView | null, extra: Partial<SupplierRequestState> = {}): SupplierRequestState => ({ ...initialSupplierRequestState, request, ...extra });

describe("#156 estado do pedido ao fornecedor: transições", () => {
  it("#156: sem pedido carregado, nada é desenhado", () => {
    expect(viewOf(initialSupplierRequestState)).toBeNull();
    expect(viewOf(supplierRequestReducer(initialSupplierRequestState, { type: "loaded", request: null }))).toBeNull();
  });

  it("#156: carregar um rascunho mostra o rascunho", () => {
    expect(viewOf(supplierRequestReducer(initialSupplierRequestState, { type: "loaded", request: draft }))).toEqual(draft);
  });

  it("#156: a busca periódica troca escrevendo por rascunho", () => {
    const next = supplierRequestReducer(withRequest({ status: "writing" }), { type: "loaded", request: draft });
    expect(viewOf(next)?.status).toBe("draft");
  });

  it("#156: a busca periódica não pisa numa ação em andamento nem numa edição", () => {
    const busy = withRequest({ status: "writing" }, { pending: "redo" });
    expect(supplierRequestReducer(busy, { type: "loaded", request: draft })).toBe(busy);
    const editing = withRequest(draft, { editing: true });
    expect(supplierRequestReducer(editing, { type: "loaded", request: { status: "writing" } })).toBe(editing);
  });

  it("#156: iniciar a ação marca o pendente e limpa o erro anterior", () => {
    const next = supplierRequestReducer(withRequest(draft, { error: "antigo" }), { type: "started", pending: "send" });
    expect(next.pending).toBe("send");
    expect(next.error).toBeUndefined();
  });

  it("#156: a ação feita guarda o pedido novo e solta o pendente", () => {
    const sent: SupplierRequestView = { status: "sent", sentBy: "ana@jachegou.test", sentAt: "2026-11-15T13:40:00Z", email };
    const next = supplierRequestReducer(withRequest(draft, { pending: "send" }), { type: "done", request: sent });
    expect(next.request).toEqual(sent);
    expect(next.pending).toBeUndefined();
  });

  it("#156: a ação recusada volta ao estado de antes, com a mensagem", () => {
    const next = supplierRequestReducer(withRequest(draft, { pending: "send" }), { type: "failed", error: "mensagem" });
    expect(next.request).toEqual(draft);
    expect(next.pending).toBeUndefined();
    expect(next.error).toBe("mensagem");
  });

  it("#156: editar abre a edição com o texto do e-mail; os botões do rascunho viram os da edição", () => {
    const next = supplierRequestReducer(withRequest(draft), { type: "editStarted" });
    expect(viewOf(next)?.status).toBe("editing");
    // #156 A edição abre com o molde ({{chave}}), o que o PATCH reenvia; o corpo desenhado é o renderizado.
    expect(next.draftText).toBe("Texto {{valor}} original");
  });

  it("#156: só um rascunho se edita, e não durante uma ação", () => {
    const sent = withRequest({ status: "writing" });
    expect(supplierRequestReducer(sent, { type: "editStarted" })).toBe(sent);
    const busy = withRequest(draft, { pending: "send" });
    expect(supplierRequestReducer(busy, { type: "editStarted" })).toBe(busy);
  });

  it("#156: cancelar a edição volta ao rascunho e esquece o erro", () => {
    const next = supplierRequestReducer(withRequest(draft, { editing: true, error: "x", draftText: "digitado" }), { type: "editCancelled" });
    expect(viewOf(next)?.status).toBe("draft");
    expect(next.error).toBeUndefined();
  });

  it("#156: salvar com erro mantém a edição aberta com o texto digitado", () => {
    const editing = withRequest(draft, { editing: true, draftText: "digitado", pending: "save" });
    const next = supplierRequestReducer(editing, { type: "failed", error: "mensagem" });
    expect(viewOf(next)?.status).toBe("editing");
    expect(next.draftText).toBe("digitado");
  });

  it("#156: salvar com sucesso fecha a edição e traz o texto novo", () => {
    const saved: SupplierRequestView = { status: "draft", email: { ...email, body: "Texto novo", template: "Texto novo" } };
    const next = supplierRequestReducer(withRequest(draft, { editing: true, pending: "save" }), { type: "done", request: saved });
    expect(next.editing).toBe(false);
    expect(viewOf(next)).toEqual(saved);
  });

  it("#156: digitar guarda o texto", () => {
    expect(supplierRequestReducer(withRequest(draft, { editing: true }), { type: "textChanged", text: "abc" }).draftText).toBe("abc");
  });
});

describe("#156 estado do pedido ao fornecedor: mensagem por status", () => {
  const errors = texts.supplierRequest.errors;
  it.each([
    [403, errors.forbidden],
    [409, errors.conflict],
    [422, errors.unprocessable],
    [500, errors.other],
    // #156 O status 0 é o prazo estourado da chamada: a mensagem é a do prazo (errors.timeout), não a genérica.
    [0, errors.timeout],
  ])("#156: o status %i vira a mensagem do texto", (status, message) => {
    expect(supplierRequestError(new ApiError(status, "detalhe_interno", "corpo cru da API"))).toBe(message);
  });

  it("#156: um erro que não é da API vira a mensagem genérica, sem o texto do erro", () => {
    expect(supplierRequestError(new Error("stack interno"))).toBe(errors.other);
  });
});

describe("#156 estado do pedido ao fornecedor: falha ao carregar", () => {
  const writing = withRequest({ status: "writing" });
  const pollFails = (state: SupplierRequestState, times: number): SupplierRequestState =>
    Array.from({ length: times }).reduce<SupplierRequestState>((acc) => supplierRequestReducer(acc, { type: "pollFailed" }), state);

  it("#156: o limite de falhas seguidas da consulta é 5", () => {
    expect(MAX_POLL_FAILURES).toBe(5);
  });

  it("#156: a carga inicial que falha marca a falha de carga e não inventa pedido", () => {
    const next = supplierRequestReducer(initialSupplierRequestState, { type: "loadFailed" });
    expect(next.loadFailed).toBe(true);
    expect(viewOf(next)).toBeNull();
  });

  it("#156: 4 consultas seguidas que falham não marcam a falha de carga", () => {
    const next = pollFails(writing, 4);
    expect(next.loadFailed).toBe(false);
    expect(next.pollFailures).toBe(4);
    expect(next.request).toEqual({ status: "writing" });
  });

  it("#156: a 5ª consulta seguida que falha marca a falha de carga", () => {
    expect(pollFails(writing, 5).loadFailed).toBe(true);
  });

  it("#156: uma consulta que dá certo zera a contagem das falhas seguidas", () => {
    const afterSuccess = supplierRequestReducer(pollFails(writing, 4), { type: "loaded", request: { status: "writing" } });
    expect(afterSuccess.pollFailures).toBe(0);
    expect(pollFails(afterSuccess, 4).loadFailed).toBe(false);
  });

  it("#156: tentar de novo marca o carregamento sem tirar a falha da tela", () => {
    const next = supplierRequestReducer(pollFails(writing, 5), { type: "reloadStarted" });
    expect(next.loadFailed).toBe(true);
    expect(next.reloading).toBe(true);
  });

  it("#156: recarregar com sucesso tira a falha, zera a contagem e mostra o pedido", () => {
    const retrying = supplierRequestReducer(pollFails(writing, 5), { type: "reloadStarted" });
    const next = supplierRequestReducer(retrying, { type: "loaded", request: draft });
    expect(next.loadFailed).toBe(false);
    expect(next.reloading).toBe(false);
    expect(next.pollFailures).toBe(0);
    expect(viewOf(next)).toEqual(draft);
  });

  it("#156: recarregar que falha de novo mantém a falha e solta o carregamento", () => {
    const retrying = supplierRequestReducer(supplierRequestReducer(initialSupplierRequestState, { type: "loadFailed" }), { type: "reloadStarted" });
    const next = supplierRequestReducer(retrying, { type: "loadFailed" });
    expect(next.loadFailed).toBe(true);
    expect(next.reloading).toBe(false);
  });
});
