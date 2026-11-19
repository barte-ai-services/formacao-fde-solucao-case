import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { ACTION_LABEL } from "../src/approval/labels";
import { texts } from "../src/texts";
import { fallbackContext } from "../src/shell/context";

/*
 * #160 D3 nas telas de duplicadas e de doca (a fila tem o seu caso no esqueleto, web/test/tabela-scroll-infinito.test.tsx): a intenção da D3 é não voltar
 * ao início e mostrar os números certos, e a tela segue o servidor. Aqui o servidor falso faz o que o real faz (api/src/connectors/duplicates-reader.ts,
 * api/src/dock/dock-board.ts): a nota decidida CONTINUA na lista, com o estado novo, e o `total` não muda; só os agregados da doca descem. A tela
 * atualiza a linha no lugar, sem esqueleto nem volta ao início, e o contador e o rodapé batem com as linhas.
 */

const money = (cents: number) => ({ cents, text: `R$ ${(cents / 100).toFixed(2).replace(".", ",")}` });
const decided = new Set<string>();

/** #160 A proposta da nota na gaveta: a duplicada e a nota da doca são propostas aguardando a decisão de quem pode aprovar. */
const detail = (key: string) => ({
  invoiceAccessKey: key, number: key.replace(/\D/g, ""), supplierId: "F12", store: "CD-01", issuedOn: "2026-11-10", total: money(100_000), classification: "E6", exceptionCode: "E6", exceptionName: "Duplicidade", level: "bloqueio", line: 1, reason: "x", requiredApproverLevel: "coordenacao", amountAtRisk: money(50_000), dockAction: { kind: "recusar" }, state: "aguardando_aprovacao", canApprove: true,
  justification: "Duplicidade", items: [], divergences: [{ classification: "E6", exceptionCode: "E6", exceptionName: "Duplicidade", skus: ["SKU-1"], evidence: [{ source: "erp_contas_a_pagar", reference: "NF-77", description: "Mesma ordem já lançada" }] }],
  title: { state: "lancado", amount: money(100_000), dueOn: "2026-11-10" }, approval: null,
});

/** #160 O servidor mantém a nota decidida: ela só muda de estado, e `item` lê `decided` para isso. */
function serve(path: string, total: number, body: (items: unknown[], count: number) => unknown, item: (n: number) => { key: string }) {
  const calls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://web.test");
      if (url.pathname.startsWith("/api/supplier-requests/")) return Response.json({ request: null });
      if (url.pathname.startsWith("/api/propostas/")) {
        const key = decodeURIComponent(url.pathname.split("/")[3]!);
        if (init.method === "POST") {
          decided.add(key);
          return Response.json({ approval: { approver: "c", approverLevel: "coordenacao", dockAction: { kind: "recusar" }, justification: "x", decidedOn: "2026-11-15" }, title: { state: "bloqueado", amount: money(1) } });
        }
        return Response.json(detail(key));
      }
      if (url.pathname !== path) return Response.json({ error: "not_found" }, { status: 404 });
      calls.push(url);
      const cursor = url.searchParams.get("cursor");
      const at = cursor === null ? 0 : Number(cursor);
      const items = Array.from({ length: Math.min(30, total - at) }, (_, k) => item(at + k + 1));
      return Response.json({ ...(body(items, total) as object), nextCursor: at + 30 < total ? String(at + 30) : null });
    }),
  );
  return calls;
}

class FakeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  decided.clear();
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => vi.unstubAllGlobals());

const noteRows = () => Array.from(document.querySelectorAll<HTMLElement>("tbody tr")).filter((tr) => (tr.getAttribute("aria-label") ?? "").startsWith("Abrir"));
const decide = async () => {
  fireEvent.click(await screen.findByRole("radio", { name: /^Recusar/ }));
  fireEvent.click(screen.getByRole("button", { name: "Registrar a decisão" }));
  expect(await screen.findByText("Decisão registrada")).toBeTruthy();
};

const dupItem = (n: number) => ({
  key: `d${n}`,
  duplicate: { accessKey: `d${n}`, number: String(n), supplierId: "FORN-07", issuedOn: "2026-11-10", totalCents: 120_960, total: "R$ 1.209,60" },
  original: { accessKey: `o${n}`, number: String(n + 1000), status: "lançada" },
  reason: "titulo_lancado",
  titleState: decided.has(`d${n}`) ? "bloqueado" : "lancado",
  blockedAmountCents: 120_960,
  blockedAmount: "R$ 1.209,60",
});
const dupBody = (total: number) => (items: unknown[]) => ({ items, total, aggregates: { blockedAmount: money(120_960 * total), byReason: { titulo_lancado: total, ordem_sem_saldo: 0 } } });

const dockItem = (n: number) => ({
  key: `r${n}`,
  invoiceAccessKey: `r${n}`,
  number: String(n),
  supplierId: "F08",
  items: [{ sku: "SKU-1025", description: "Macarrão", quantity: { amount: 1, unit: "CX" } }],
  status: decided.has(`r${n}`) ? { kind: "acao", action: { kind: "recusar" }, publishedAt: "2026-11-11T10:00:00Z" } : { kind: "aguardando_aprovacao", instrucao: "Aguardando aprovação, não descarregue" },
  decidedBy: null,
});
const dockBody = (awaitingAtStart: number, total: number) => (items: unknown[]) => ({ destination: "CD-03", date: "2026-11-11", destinations: ["CD-03"], items, total, aggregates: { awaiting: awaitingAtStart - decided.size } });

describe("#160 decidir na gaveta, nas duplicadas e na doca (o servidor mantém a nota decidida)", () => {
  it("#160/AC-4: duplicadas: a linha decidida fica no lugar com o estado novo, o total não muda e a lista não recomeça", async () => {
    const calls = serve("/api/duplicates", 65, dupBody(65), dupItem);
    window.history.replaceState(null, "", "/pagar/duplicadas"); // ADR-004
    render(<Frame context={fallbackContext("coordenacao@jachegou.test")} />);
    await waitFor(() => expect(noteRows()).toHaveLength(30));
    expect(within(noteRows()[0]!).getByText(texts.duplicadas.badge.pendente)).toBeTruthy();
    fireEvent.click(screen.getByText("NF 1"));
    await decide();
    await waitFor(() => expect(within(noteRows()[0]!).getByText(texts.duplicadas.badge.bloqueado)).toBeTruthy());
    expect(noteRows()).toHaveLength(30);
    expect(screen.getByText("65 notas")).toBeTruthy();
    // #160 Sem recomeço: nenhuma linha de esqueleto, e a gaveta continua mostrando a decisão
    expect(document.querySelectorAll("tbody tr")).toHaveLength(30);
    expect(screen.getByText("Decisão registrada")).toBeTruthy();
    // #160 O primeiro bloco é pedido de novo, em segundo plano, para trocar a linha e reler `total` e `aggregates`
    expect(calls.filter((url) => url.searchParams.get("cursor") === null).length).toBeGreaterThanOrEqual(2);
  });

  it("#160/AC-3: duplicadas: depois de decidir, o contador e o rodapé batem com as linhas na tela", async () => {
    serve("/api/duplicates", 3, dupBody(3), dupItem);
    window.history.replaceState(null, "", "/pagar/duplicadas"); // ADR-004
    render(<Frame context={fallbackContext("coordenacao@jachegou.test")} />);
    await waitFor(() => expect(noteRows()).toHaveLength(3));
    expect(screen.getByText(texts.scrollTable.endOfList(3))).toBeTruthy();
    fireEvent.click(screen.getByText("NF 1"));
    await decide();
    await waitFor(() => expect(within(noteRows()[0]!).getByText(texts.duplicadas.badge.bloqueado)).toBeTruthy());
    expect(noteRows()).toHaveLength(3);
    expect(screen.getByText("3 notas")).toBeTruthy();
    expect(screen.getByText(texts.scrollTable.endOfList(3))).toBeTruthy();
  });

  it("#160/AC-4: doca: a nota decidida fica no lugar com a ação nova, o total não muda e o aviso de aguardando vem da releitura dos agregados", async () => {
    serve("/api/doca", 64, dockBody(4, 64), dockItem);
    window.history.replaceState(null, "", "/doca"); // ADR-004
    render(<Frame context={fallbackContext("coordenacao@jachegou.test")} />);
    await waitFor(() => expect(noteRows()).toHaveLength(30));
    expect(screen.getByText("4 notas aguardam aprovação.")).toBeTruthy();
    fireEvent.click(screen.getByText("NF 1"));
    await decide();
    await waitFor(() => expect(within(noteRows()[0]!).getByText(ACTION_LABEL.recusar)).toBeTruthy());
    expect(noteRows()).toHaveLength(30);
    expect(screen.getByText("64 notas")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("3 notas aguardam aprovação.")).toBeTruthy());
    expect(document.querySelectorAll("tbody tr")).toHaveLength(30);
  });

  it("#160/AC-3: doca: depois de decidir, o contador e o rodapé batem com as linhas na tela", async () => {
    serve("/api/doca", 3, dockBody(3, 3), dockItem);
    window.history.replaceState(null, "", "/doca"); // ADR-004
    render(<Frame context={fallbackContext("coordenacao@jachegou.test")} />);
    await waitFor(() => expect(noteRows()).toHaveLength(3));
    expect(screen.getByText(texts.scrollTable.endOfList(3))).toBeTruthy();
    fireEvent.click(screen.getByText("NF 1"));
    await decide();
    await waitFor(() => expect(within(noteRows()[0]!).getByText(ACTION_LABEL.recusar)).toBeTruthy());
    expect(noteRows()).toHaveLength(3);
    expect(screen.getByText("3 notas")).toBeTruthy();
    expect(screen.getByText(texts.scrollTable.endOfList(3))).toBeTruthy();
    await waitFor(() => expect(screen.getByText("2 notas aguardam aprovação.")).toBeTruthy());
  });
});
