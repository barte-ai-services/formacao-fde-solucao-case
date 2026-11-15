import { render, screen, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { navigate } from "../src/router";
import { ROUTES } from "../src/routes";
import { fallbackContext } from "../src/shell/context";

/** Um caminho de exemplo para cada rota da tabela, com o título e o texto vazio esperados. */
const EXPECTED: Record<string, { path: string; title: string; empty: string }> = {
  "/pagar/fila": { path: "/pagar/fila", title: "Fila de aprovação", empty: "Nenhuma proposta esperando você" },
  "/pagar/fila/:id": { path: "/pagar/fila/35261100", title: "Proposta da nota 35261100", empty: "Esta proposta ainda não chegou" },
  "/pagar/hoje": { path: "/pagar/hoje", title: "Lista do dia", empty: "Nenhum título liberado hoje" },
  "/pagar/duplicadas": { path: "/pagar/duplicadas", title: "Notas duplicadas", empty: "Nenhuma nota duplicada neste mês" },
  "/pagar/valor-barrado": { path: "/pagar/valor-barrado", title: "Valor barrado", empty: "Nada barrado neste mês ainda" },
  "/doca": { path: "/doca", title: "Doca", empty: "Nenhuma nota com entrega prevista hoje" },
  "/devolucoes": { path: "/devolucoes", title: "Notas de devolução", empty: "Nenhuma devolução pendente de emissão" },
  "/recebimento/loja": { path: "/recebimento/loja", title: "Recebimento na loja", empty: "Nenhuma nota com entrega prevista hoje" },
};

function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  return render(<Frame context={fallbackContext("aluna@barte.com")} />);
}

/** #63 A API vazia: a fila e a lista do dia sem itens, e nenhuma proposta (404). */
function emptyApi(input: RequestInfo | URL): Promise<Response> {
  const path = String(input);
  if (path.startsWith("/api/propostas/")) return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
  if (path === "/api/fila") return Promise.resolve(Response.json({ approver: { email: null, level: null }, items: [] }));
  if (path.startsWith("/api/doca") || path.startsWith("/api/recebimento-loja")) return Promise.resolve(Response.json({ destination: null, date: "2026-11-15", destinations: [], awaiting: 0, rows: [] }));
  if (path === "/api/return-notes") return Promise.resolve(Response.json({ notes: [] }));
  if (path === "/api/duplicates") return Promise.resolve(Response.json({ duplicates: [], count: 0 }));
  if (path === "/api/hoje") return Promise.resolve(Response.json({ day: "2026-11-15", items: [], total: { cents: 0 } }));
  if (path === "/api/valor-barrado") return Promise.resolve(Response.json({ month: "2026-11", baselineCents: 54300000, barred: { totalCents: 0, byException: [] }, ifApprovedAsProposed: { totalCents: 0, byException: [] }, daily: [] }));
  return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
}

describe("#60/AC-1 cada rota abre na moldura do Shell com o estado vazio", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(emptyApi)));
  afterEach(() => vi.unstubAllGlobals());

  it("a tabela de rotas e a lista esperada são as mesmas", () => {
    expect(ROUTES.map((r) => r.path).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const route of ROUTES) {
    const expected = EXPECTED[route.path]!;
    it(`#60/AC-1 ${route.path}`, async () => {
      renderAt(expected.path);
      // A moldura de verdade: a navegação do contas a pagar está lá.
      expect(screen.getAllByText("Fila de aprovação").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Doca (CD)").length).toBeGreaterThan(0);
      expect(screen.getByRole("heading", { name: expected.title })).toBeTruthy();
      expect(await screen.findByText(new RegExp(expected.empty))).toBeTruthy();
    });
  }

  it("/ leva à fila", async () => {
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Fila de aprovação" })).toBeTruthy();
    expect(window.location.pathname).toBe("/pagar/fila");
  });

  it("caminho desconhecido mostra Página não encontrada, na moldura", () => {
    renderAt("/pagar/nao-existe");
    expect(screen.getByRole("heading", { name: "Página não encontrada" })).toBeTruthy();
    expect(screen.getAllByText("Lista do dia").length).toBeGreaterThan(0);
  });

  it("navegar não recarrega: troca a tela no lugar e o voltar do navegador volta", async () => {
    renderAt("/pagar/fila");
    act(() => navigate("/doca"));
    expect(await screen.findByRole("heading", { name: "Doca" })).toBeTruthy();
    expect(window.location.pathname).toBe("/doca");
    act(() => {
      window.history.replaceState(null, "", "/pagar/hoje");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const main = document.body;
    expect(await within(main).findByRole("heading", { name: "Lista do dia" })).toBeTruthy();
  });
});
