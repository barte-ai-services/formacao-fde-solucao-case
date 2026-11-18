import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { texts } from "../texts";
import type { SupplierRequestView } from "./SupplierRequestBlock";
import type { SupplierRequestPort } from "./supplier-request-state";
import { useSupplierRequest } from "./useSupplierRequest";

// #3 O gancho do bloco "Pedido ao fornecedor" (#16): o que ele entrega ao bloco, sem desenhar nada.
// #16 O caminho pela tela inteira está em SupplierRequestSection.test.tsx.

const KEY = "35261100000000000000550010000080001000080001";
const email = { to: "fiscal@higienetotal.test", dueOn: "2026-11-18", subject: "NF 80", body: "Texto", template: "Texto {{valor}}" };
const draft: SupplierRequestView = { status: "draft", email };

const port = (over: Partial<SupplierRequestPort> = {}): SupplierRequestPort => ({
  load: vi.fn(async () => draft),
  send: vi.fn(async () => ({ status: "sent", sentBy: "ana", sentAt: "2026-11-15T13:40:00Z", email }) as SupplierRequestView),
  resend: vi.fn(),
  discard: vi.fn(),
  redo: vi.fn(),
  saveTemplate: vi.fn(),
  ...over,
});

describe("#3 gancho useSupplierRequest", () => {
  it("#3/AC-1: antes de carregar, o pedido é nulo e o bloco não existe", () => {
    const { result } = renderHook(() => useSupplierRequest(port({ load: vi.fn(() => new Promise<null>(() => undefined)) }), KEY));
    expect(result.current.request).toBeNull();
  });

  it("#3/AC-3: carregado, entrega o rascunho", async () => {
    const { result } = renderHook(() => useSupplierRequest(port(), KEY));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
  });

  it("#3/AC-4: onSend passa pelo pendente e termina em enviada", async () => {
    const p = port();
    const { result } = renderHook(() => useSupplierRequest(p, KEY));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    act(() => result.current.onSend());
    expect(result.current.pending).toBe("send");
    await waitFor(() => expect(result.current.request?.status).toBe("sent"));
    expect(result.current.pending).toBeUndefined();
    expect(p.send).toHaveBeenCalledWith(KEY);
  });

  it("#3/AC-4: a ação recusada entrega a mensagem do status, nunca o texto do erro", async () => {
    const p = port({ send: vi.fn(async () => Promise.reject(new ApiError(409, "interno", "corpo cru"))) });
    const { result } = renderHook(() => useSupplierRequest(p, KEY));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    act(() => result.current.onSend());
    await waitFor(() => expect(result.current.error).toBe(texts.supplierRequest.errors.conflict));
    expect(result.current.request?.status).toBe("draft");
  });

  it("#3/AC-4: a ação que estoura o prazo (status 0) recarrega o pedido, e o que o servidor concluiu aparece com a mensagem fixa", async () => {
    const sent: SupplierRequestView = { status: "sent", sentBy: "ana", sentAt: "2026-11-15T13:40:00Z", email };
    const load = vi.fn<SupplierRequestPort["load"]>().mockResolvedValueOnce(draft).mockResolvedValue(sent);
    const p = port({ load, send: vi.fn(async () => Promise.reject(new ApiError(0, null, "não consegui falar com a API"))) });
    const { result } = renderHook(() => useSupplierRequest(p, KEY));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    act(() => result.current.onSend());
    await waitFor(() => expect(result.current.request?.status).toBe("sent"));
    expect(result.current.error).toBe(texts.supplierRequest.errors.timeout);
    expect(result.current.pending).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("#3/AC-4: o status 0 com a releitura também falha mantém o estado de antes e a mensagem fixa", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockResolvedValueOnce(draft).mockRejectedValue(new ApiError(0, null, "x"));
    const p = port({ load, send: vi.fn(async () => Promise.reject(new ApiError(0, null, "x"))) });
    const { result } = renderHook(() => useSupplierRequest(p, KEY));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    act(() => result.current.onSend());
    await waitFor(() => expect(result.current.error).toBe(texts.supplierRequest.errors.timeout));
    expect(result.current.request?.status).toBe("draft");
    expect(result.current.loadFailed).toBe(false);
  });

  it("#3/AC-4: recusa com status que não é 0 não recarrega", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockResolvedValue(draft);
    const p = port({ load, send: vi.fn(async () => Promise.reject(new ApiError(409, null, "x"))) });
    const { result } = renderHook(() => useSupplierRequest(p, KEY));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    act(() => result.current.onSend());
    await waitFor(() => expect(result.current.error).toBe(texts.supplierRequest.errors.conflict));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("#3/AC-6: onEdit entrega o estado editing e onCancelEdit devolve o rascunho", async () => {
    const { result } = renderHook(() => useSupplierRequest(port(), KEY));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    act(() => result.current.onEdit());
    expect(result.current.request?.status).toBe("editing");
    expect(result.current.draftText).toBe("Texto {{valor}}"); // #17 o molde, não o corpo renderizado
    act(() => result.current.onCancelEdit());
    expect(result.current.request?.status).toBe("draft");
  });

  it("#3/AC-2: o intervalo da consulta é o que a gaveta passa", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockResolvedValueOnce({ status: "writing" }).mockResolvedValue(draft);
    const { result } = renderHook(() => useSupplierRequest(port({ load }), KEY, 10));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("#3/AC-9 gancho useSupplierRequest: falha ao carregar", () => {
  const writing: SupplierRequestView = { status: "writing" };
  const boom = () => new ApiError(500, "codigo_interno", "corpo cru");

  it("#3/AC-9: a carga inicial que falha entrega a falha de carga, não um bloco ausente sem aviso", async () => {
    const { result } = renderHook(() => useSupplierRequest(port({ load: vi.fn(async () => Promise.reject(boom())) }), KEY));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    expect(result.current.request).toBeNull();
    expect(JSON.stringify(result.current)).not.toMatch(/corpo cru|codigo_interno/);
  });

  it("#3/AC-9: 4 consultas seguidas que falham e depois uma que dá certo seguem consultando, sem falha de carga", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockResolvedValueOnce(writing);
    for (let i = 0; i < 4; i += 1) load.mockRejectedValueOnce(boom());
    load.mockResolvedValueOnce(writing).mockResolvedValue(draft);
    const { result } = renderHook(() => useSupplierRequest(port({ load }), KEY, 5));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    expect(result.current.loadFailed).toBeFalsy();
    expect(load).toHaveBeenCalledTimes(7);
  });

  it("#3/AC-9: 5 consultas seguidas que falham param a consulta e entregam a falha de carga", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockResolvedValueOnce(writing).mockRejectedValue(boom());
    const { result } = renderHook(() => useSupplierRequest(port({ load }), KEY, 5));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    const calls = load.mock.calls.length;
    expect(calls).toBe(6);
    await new Promise((r) => setTimeout(r, 60));
    expect(load.mock.calls.length).toBe(calls);
  });

  it("#3/AC-9: onReload recarrega o pedido e tira a falha de carga", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockRejectedValueOnce(boom()).mockResolvedValue(draft);
    const { result } = renderHook(() => useSupplierRequest(port({ load }), KEY));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    act(() => result.current.onReload());
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    expect(result.current.loadFailed).toBe(false);
    expect(result.current.reloading).toBeFalsy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("#3/AC-9: onReload depois da parada da consulta volta a consultar se o pedido ainda está escrevendo", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockResolvedValueOnce(writing);
    for (let i = 0; i < 5; i += 1) load.mockRejectedValueOnce(boom());
    load.mockResolvedValueOnce(writing).mockResolvedValue(draft);
    const { result } = renderHook(() => useSupplierRequest(port({ load }), KEY, 5));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    act(() => result.current.onReload());
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    expect(result.current.loadFailed).toBe(false);
  });
});
