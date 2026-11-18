import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { SentRequestDetailDto } from "../api/contract";
import { useRequestDetail } from "./useRequestDetail";

// #21 A leitura do pedido da gaveta: carrega pela chave, descarta o que chega de outra linha e guarda só o motivo fechado do erro.

const sent = (key: string): SentRequestDetailDto => ({
  status: "sent",
  invoiceAccessKey: key,
  requestType: "return_note",
  returnNote: { number: "ND-6", supplier: "F07", reference: "1", lines: [], total: { text: "R$ 1,00" } },
  email: { to: "a@b.example", dueOn: "2026-11-14", subject: "s", body: "b", template: "b" },
  asks: [],
  sentBy: null,
  sentAt: null,
  reading: null,
  documentConfirmation: null,
  followUp: { drafted: false, sent: false, draft: null, sentBy: null, sentAt: null, failure: null, dueOn: null },
});

describe("#21 useRequestDetail", () => {
  it("#5/AC-3: sem chave não lê nada; com a chave, carrega e fica pronto", async () => {
    const load = vi.fn(async (key: string) => sent(key));
    const { result, rerender } = renderHook(({ key }: { key: string | null }) => useRequestDetail(key, load), { initialProps: { key: null as string | null } });
    expect(result.current.state).toBe("loading");
    expect(load).not.toHaveBeenCalled();
    rerender({ key: "k1" });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.detail?.invoiceAccessKey).toBe("k1");
  });

  it("#5/AC-3: trocando de linha, o pedido da linha anterior não vale: volta a carregar até chegar o da nova", async () => {
    const load = vi.fn(async (key: string) => sent(key));
    const { result, rerender } = renderHook(({ key }: { key: string | null }) => useRequestDetail(key, load), { initialProps: { key: "k1" as string | null } });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    rerender({ key: "k2" });
    expect(result.current.state).toBe("loading");
    expect(result.current.detail).toBeUndefined();
    await waitFor(() => expect(result.current.detail?.invoiceAccessKey).toBe("k2"));
  });

  it("#21: a falha guarda só o motivo fechado, e 'tentar de novo' lê outra vez", async () => {
    const load = vi
      .fn<(key: string) => Promise<SentRequestDetailDto>>()
      .mockRejectedValueOnce(new ApiError(502, "supabase_unavailable", "texto cru da dependência"))
      .mockResolvedValueOnce(sent("k1"));
    const { result } = renderHook(() => useRequestDetail("k1", load));
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.reason).toBe("unavailable");
    expect(JSON.stringify(result.current)).not.toContain("texto cru");
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
