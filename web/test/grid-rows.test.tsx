import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilaDeAprovacao from "../src/routes/fila";
import ListaDoDia from "../src/routes/lista-do-dia";
import NotasDuplicadas from "../src/routes/duplicadas";
import Doca from "../src/routes/doca";
import RecebimentoNaLoja from "../src/routes/recebimento-loja";
import ReturnNotes from "../src/routes/devolucoes";
import { isPaged, pagedBody } from "./paged-fixture";

// #209 AC-1, AC-2 e AC-6: em cada grid, o clique na linha abre a gaveta da nota daquela linha (a da proposta, pela chave).

const money = (cents: number) => ({ cents, text: `R$ ${cents / 100}` });
const params = { params: {} };

const queueItem = (n: string) => ({
  invoiceAccessKey: `key-${n}`, number: n, supplierId: "F12", store: "CD-01", issuedOn: "2026-11-10", total: money(100_000),
  classification: "E3", exceptionCode: "E3", exceptionName: `Nome ${n}`, level: "analista", line: 1, reason: "x",
  requiredApproverLevel: "analista", amountAtRisk: money(1000), dockAction: { kind: "receber" }, state: "aguardando_aprovacao", canApprove: true,
});
const todayItem = (n: string) => ({
  invoiceAccessKey: `key-${n}`, number: n, supplierId: "F12", amount: money(1000), invoiceTotal: money(100_000), dueOn: "2026-11-15",
  exceptionCode: "E3", exceptionName: `Nome ${n}`, dockAction: "receber", approver: "regra",
});
const dockRow = (n: string) => ({
  invoiceAccessKey: `key-${n}`, number: n, supplierId: "F05", items: [{ sku: "S", description: "Feijão", quantity: { amount: 3, unit: "UN" } }],
  status: { kind: "acao", action: { kind: "receber" }, publishedAt: "2026-11-11T09:00:00Z" },
});
const board = { destination: "X", date: "2026-11-11", destinations: ["X"], awaiting: 0, rows: [dockRow("11"), dockRow("22")] };
const dup = (n: string) => ({
  duplicate: { accessKey: `key-${n}`, number: n, supplierId: "F", issuedOn: "2026-11-10", totalCents: 100, total: "R$ 1,00" },
  original: null, reason: "ordem_sem_saldo", titleState: "bloqueado", blockedAmountCents: 100, blockedAmount: "R$ 1,00",
});
const returnNote = (id: number, n: string) => ({
  id, status: "pendente", invoiceAccessKey: `key-${n}`, invoiceNumber: n, supplierId: "F", reason: "E3", lines: [], valueCents: 100,
  publishedAt: "2026-11-15T12:30:00Z", pendingSeconds: 60, emitted: null, cancelled: null,
});

function serve(routes: Record<string, unknown>): string[] {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      asked.push(path);
      if (path.startsWith("/api/propostas/")) return Response.json({ error: "not_found" }, { status: 404 });
      const hit = Object.keys(routes).find((p) => path.startsWith(p));
      const body = hit ? routes[hit] : {};
      // #160 As listas chegam em blocos: o corpo "inteiro" da rota vira a página única da API.
      return Response.json(isPaged(path) ? pagedBody(path, body) : body);
    }),
  );
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

const grids: [string, ReactElement, Record<string, unknown>][] = [
  ["fila", <FilaDeAprovacao {...params} />, { "/api/fila": { approver: { email: null, level: "analista" }, items: [queueItem("11"), queueItem("22")] } }],
  ["lista do dia", <ListaDoDia {...params} />, { "/api/hoje": { total: money(2000), items: [todayItem("11"), todayItem("22")] } }],
  ["duplicadas", <NotasDuplicadas {...params} />, { "/api/duplicates": { duplicates: [dup("11"), dup("22")], count: 2 } }],
  ["doca", <Doca {...params} />, { "/api/doca": board }],
  ["loja", <RecebimentoNaLoja {...params} />, { "/api/recebimento-loja": board }],
  ["devoluções", <ReturnNotes {...params} />, { "/api/return-notes": { notes: [returnNote(1, "11"), returnNote(2, "22")] } }],
];

describe("#209 toda linha de grid abre a gaveta da nota", () => {
  it.each(grids)("AC-6: %s — clicar na linha abre a nota daquela linha", async (_name, screenEl, routes) => {
    const asked = serve(routes);
    render(screenEl);
    const row = await screen.findByRole("row", { name: "Abrir a nota 22" });
    expect(row.getAttribute("tabindex")).toBe("0");
    fireEvent.click(within(row).getAllByRole("cell")[1]!);
    await waitFor(() => expect(asked).toContain("/api/propostas/key-22"));
    expect(asked).not.toContain("/api/propostas/key-11");
  });
});
