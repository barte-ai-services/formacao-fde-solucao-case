import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationDto, AutomationRunDto } from "../src/api/automation";
import { AutomationProvider } from "../src/components/automation-context";
import { AutomationBand } from "../src/components/AutomationBand";

// #357 AC-1 a AC-3: "Rodar agora" e o liga/desliga do modo demonstração na faixa de automação.
const run = (id: number, startedAt: string): AutomationRunDto => ({
  id, startedAt, finishedAt: startedAt, status: "ok", error: null,
  figures: { seen: 3, inserted: 3, checked: 3, failed: 0, proposed: 2, approvedByRule: 1, cadastroE8: 0, dockPublished: 1, storePublished: 0, duplicatesBlocked: 0 },
});
const indicators: AutomationDto["indicators"] = {
  day: { date: "2026-11-16", decided: 0, byRule: 0, withoutPersonPct: null, medianSeconds: { withoutPerson: null, withPerson: null } },
  month: { month: "2026-11", decided: 0, byRule: 0, withoutPersonPct: null, medianSeconds: { withoutPerson: null, withPerson: null } },
};
const dto = (extra: Partial<AutomationDto> = {}): AutomationDto => ({
  state: "ok", last: run(1, "2026-11-16T13:15:00Z"), next: "2026-11-16T13:30:00Z", runs: [run(1, "2026-11-16T13:15:00Z")], indicators,
  demo: { enabled: false, changedAt: null }, intervalMinutes: 15, skipped: [], isAdmin: false, ...extra,
});
const NOW = () => new Date("2026-11-16T13:18:00Z");

const posts: { url: string; body: unknown }[] = [];
const stubFetch = (reply: (url: string) => { status: number; body?: unknown } = () => ({ status: 202, body: {} })) =>
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const { status, body } = reply(url);
    return new Response(JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json" } });
  }));
afterEach(() => { vi.unstubAllGlobals(); posts.length = 0; });

const band = (loads: AutomationDto[]) => {
  let n = 0;
  const load = vi.fn(async () => loads[Math.min(n++, loads.length - 1)]!);
  render(<AutomationProvider load={load}><AutomationBand now={NOW} /></AutomationProvider>);
  return load;
};

describe("#357 AC-1 quem vê os controles", () => {
  it("o administrador vê Rodar agora e o liga/desliga", async () => {
    band([dto({ isAdmin: true })]);
    expect(await screen.findByRole("button", { name: "Rodar agora" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Ligar modo demonstração" })).toBeTruthy();
  });
  it("quem não é administrador não vê nenhum dos dois", async () => {
    band([dto({ isAdmin: false })]);
    await screen.findByText(/Automático · última rodada/);
    expect(screen.queryByText("Rodar agora")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });
  it("resposta sem isAdmin (API de antes) não mostra os controles", async () => {
    const { isAdmin: _drop, ...old } = dto();
    band([old as AutomationDto]);
    await screen.findByText(/Automático · última rodada/);
    expect(screen.queryByText("Rodar agora")).toBeNull();
  });
  it("administrador sem nenhuma rodada ainda tem a faixa, para pedir a primeira", async () => {
    band([dto({ isAdmin: true, last: null, runs: [] })]);
    expect(await screen.findByRole("button", { name: "Rodar agora" })).toBeTruthy();
  });
});

describe("#357 AC-2 as ações chamam a API e a faixa recarrega", () => {
  it("Rodar agora: POST /api/admin/rodar-agora e a faixa recarrega com a rodada nova", async () => {
    stubFetch();
    const load = band([dto({ isAdmin: true }), dto({ isAdmin: true, last: run(2, "2026-11-16T13:20:00Z"), runs: [run(2, "2026-11-16T13:20:00Z"), run(1, "2026-11-16T13:15:00Z")] })]);
    fireEvent.click(await screen.findByRole("button", { name: "Rodar agora" }));
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual(["/api/admin/rodar-agora"]));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/última rodada às 10h20/)).toBeTruthy();
  });
  it("liga/desliga: POST /api/admin/modo-demonstracao com exatamente { enabled } e a faixa reflete o modo", async () => {
    stubFetch(() => ({ status: 200, body: { enabled: true } }));
    const load = band([dto({ isAdmin: true }), dto({ isAdmin: true, demo: { enabled: true, changedAt: "2026-11-16T13:19:00Z" }, intervalMinutes: 1 })]);
    fireEvent.click(await screen.findByRole("switch", { name: "Ligar modo demonstração" }));
    await waitFor(() => expect(posts).toEqual([{ url: "/api/admin/modo-demonstracao", body: { enabled: true } }]));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Modo demonstração")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Ligar modo demonstração" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Ligar modo demonstração" }));
    await waitFor(() => expect(posts[1]?.body).toEqual({ enabled: false }));
  });
  it("falha da API: mensagem na faixa, sem recarregar", async () => {
    stubFetch(() => ({ status: 502, body: { error: "modo_demonstracao_failed" } }));
    const load = band([dto({ isAdmin: true })]);
    fireEvent.click(await screen.findByRole("switch", { name: "Ligar modo demonstração" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Não consegui mudar o modo demonstração");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("#357 AC-3 modo demonstração e rodada pulada", () => {
  it("modo ligado: a faixa mostra Modo demonstração, também para quem não é administrador", async () => {
    band([dto({ demo: { enabled: true, changedAt: "2026-11-16T13:00:00Z" }, intervalMinutes: 1 })]);
    expect(await screen.findByText("Modo demonstração")).toBeTruthy();
  });
  it("modo desligado: nada de Modo demonstração", async () => {
    band([dto()]);
    await screen.findByText(/Automático · última rodada/);
    expect(screen.queryByText("Modo demonstração")).toBeNull();
  });
  it("rodada skipped aparece como pulada, e também na lista de rodadas", async () => {
    band([dto({ skipped: [{ id: 9, startedAt: "2026-11-16T13:17:00Z", origin: "manual", demoEnabled: false }] })]);
    expect((await screen.findByTestId("automation-skipped")).textContent).toBe("Rodada pulada às 10h17: outra rodada ainda estava correndo.");
    fireEvent.click(screen.getByRole("button", { name: "Ver rodadas" }));
    expect(await screen.findByText("Pulada")).toBeTruthy();
  });
  it("sem puladas: nenhuma linha de pulada", async () => {
    band([dto()]);
    await screen.findByText(/Automático · última rodada/);
    expect(screen.queryByTestId("automation-skipped")).toBeNull();
  });
});
