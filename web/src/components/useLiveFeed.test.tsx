import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_MS, useLiveFeed } from "./useLiveFeed";

/*
 * #355 O laço de atualização do ao vivo: um pedido por vez, o mesmo cursor depois de uma falha, nada em voo nem agendado depois de sair da tela,
 * e a falha não leva o texto do servidor para a tela. O fetch é simulado; o tempo, falso.
 */

const day = { date: "2026-11-20", decided: 1, byRule: 1, withoutPersonPct: 100 };
const step = (n: number) => ({ kind: "human_decision", at: "2026-11-20T13:00:00.000Z", actor: "person", actor_name: "Ana", step: `Passo ${n}`, invoice: { access_key: `K${n}`, number: String(n) } });
const body = (n: number, since: string) => ({ events: [step(n)], since, indicators: { day, month: {} }, awaiting: 0 });

let sent: string[];
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("#355/AC-2 useLiveFeed", () => {
  it("não abre um pedido novo enquanto o anterior não terminou", async () => {
    let finish: (() => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      sent.push(String(input));
      if (sent.length === 1) return Promise.resolve(Response.json(body(1, "S1")));
      return new Promise<Response>((resolve) => { finish = () => resolve(Response.json(body(2, "S2"))); });
    }));
    const { result } = renderHook(() => useLiveFeed());
    await tick(0);
    expect(result.current.state).toBe("ready");
    await tick(POLL_MS);
    expect(sent).toEqual(["/api/ao-vivo", "/api/ao-vivo?since=S1"]);
    // O segundo pedido segue pendurado por muito mais que um período: nenhum terceiro sai.
    await tick(POLL_MS * 4);
    expect(sent).toHaveLength(2);
    await act(async () => finish?.());
    expect(result.current.feed?.rows).toHaveLength(2);
  });

  it("depois de uma falha a lista fica, o cursor não anda, e a tela não recebe o texto do servidor", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      sent.push(String(input));
      call += 1;
      if (call === 2) return Promise.resolve(Response.json({ error: "chave-do-servidor-123" }, { status: 502 }));
      return Promise.resolve(Response.json(body(call, `S${call}`)));
    }));
    const { result } = renderHook(() => useLiveFeed());
    await tick(0);
    await tick(POLL_MS);
    expect(result.current.stale).toBe(true);
    expect(result.current.state).toBe("ready");
    expect(JSON.stringify(result.current)).not.toContain("chave-do-servidor-123");
    await tick(POLL_MS);
    expect(sent[2]).toBe("/api/ao-vivo?since=S1");
    expect(result.current.stale).toBe(false);
  });

  it("ao sair da tela, o pedido em voo é cancelado e nenhum outro é agendado", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(input));
      if (sent.length === 1) return Promise.resolve(Response.json(body(1, "S1")));
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    }));
    const { unmount } = renderHook(() => useLiveFeed());
    await tick(POLL_MS);
    expect(signals).toHaveLength(1);
    unmount();
    expect(signals[0]?.aborted).toBe(true);
    await tick(POLL_MS * 3);
    expect(sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
