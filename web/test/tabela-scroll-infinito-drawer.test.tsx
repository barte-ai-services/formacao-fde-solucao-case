import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { fallbackContext } from "../src/shell/context";

/*
 * #160 D3 nas telas de duplicadas e de doca (a fila tem o seu caso no esqueleto, web/test/tabela-scroll-infinito.test.tsx): decidir na gaveta tira
 * a linha, o contador e os números do topo descem, e a lista não recomeça (a gaveta segue aberta com "Decisão registrada" e a rolagem fica).
 * O contrato não fixa como os números se atualizam; aqui a API fake responde o primeiro bloco de novo sem a nota decidida, e a tela só o lê
 * para `total` e `aggregates`.
 */

const money = (cents: number) => ({ cents, text: `R$ ${(cents / 100).toFixed(2).replace(".", ",")}` });
const decided = new Set<string>();

/** #160 A proposta da nota na gaveta: a duplicada e a nota da doca são propostas aguardando a decisão de quem pode aprovar. */
const detail = (key: string) => ({
  invoiceAccessKey: key, number: key.replace(/\D/g, ""), supplierId: "F12", store: "CD-01", issuedOn: "2026-11-10", total: money(100_000), classification: "E6", exceptionCode: "E6", exceptionName: "Duplicidade", level: "bloqueio", line: 1, reason: "x", requiredApproverLevel: "coordenacao", amountAtRisk: money(50_000), dockAction: { kind: "recusar" }, state: "aguardando_aprovacao", canApprove: true,
  justification: "Duplicidade", items: [], divergences: [{ classification: "E6", exceptionCode: "E6", exceptionName: "Duplicidade", skus: ["SKU-1"], evidence: [{ source: "erp_contas_a_pagar", reference: "NF-77", description: "Mesma ordem já lançada" }] }],
  title: { state: "lancado", amount: money(100_000), dueOn: "2026-11-10" }, approval: null,
});

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
      const items = Array.from({ length: Math.min(30, total - at) }, (_, k) => item(at + k + 1)).filter((row) => !decided.has(row.key));
      return Response.json(body(items, total - decided.size) as object);
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

const noteRows = () => Array.from(document.querySelectorAll("tbody tr")).filter((tr) => (tr.getAttribute("aria-label") ?? "").startsWith("Abrir"));
const decide = async () => {
  fireEvent.click(await screen.findByRole("radio", { name: /^Recusar/ }));
  fireEvent.click(screen.getByRole("button", { name: "Registrar a decisão" }));
  expect(await screen.findByText("Decisão registrada")).toBeTruthy();
};

describe("#160 decidir na gaveta, nas duplicadas e na doca", () => {
  it("#160/AC-4: duplicadas: a linha decidida sai, o total e o Stat descem e a gaveta segue aberta, sem recomeçar a lista", async () => {
    const dupItem = (n: number) => ({
      key: `d${n}`,
      duplicate: { accessKey: `d${n}`, number: String(n), supplierId: "FORN-07", issuedOn: "2026-11-10", totalCents: 120_960, total: "R$ 1.209,60" },
      original: { accessKey: `o${n}`, number: String(n + 1000), status: "lançada" },
      reason: "titulo_lancado",
      titleState: "bloqueado",
      blockedAmountCents: 120_960,
      blockedAmount: "R$ 1.209,60",
    });
    const calls = serve("/api/duplicates", 65, (items, count) => ({ items, nextCursor: items.length === 30 ? "30" : null, total: count, aggregates: { blockedAmount: money(7_862_400), byReason: { titulo_lancado: 65, ordem_sem_saldo: 0 } } }), dupItem);
    window.history.replaceState(null, "", "/pagar/duplicadas"); // ADR-004
    render(<Frame context={fallbackContext("coordenacao@jachegou.test")} />);
    await waitFor(() => expect(noteRows()).toHaveLength(30));
    fireEvent.click(screen.getByText("NF 1"));
    await decide();
    await waitFor(() => expect(noteRows()).toHaveLength(29));
    expect(screen.getByText("64 notas")).toBeTruthy();
    // #160 Sem recomeço: nenhuma linha de esqueleto, e a gaveta continua mostrando a decisão
    expect(document.querySelectorAll("tbody tr")).toHaveLength(29);
    expect(screen.getByText("Decisão registrada")).toBeTruthy();
    // #160 Dois pedidos sem cursor: o primeiro bloco e a releitura de `total` e `aggregates` depois da decisão
    expect(calls.filter((url) => url.searchParams.get("cursor") === null)).toHaveLength(2);
  });

  it("#160/AC-4: doca: a nota decidida sai, o contador desce e o aviso de aguardando vem da releitura dos agregados", async () => {
    const dockItem = (n: number) => ({ key: `r${n}`, invoiceAccessKey: `r${n}`, number: String(n), supplierId: "F08", items: [{ sku: "SKU-1025", description: "Macarrão", quantity: { amount: 1, unit: "CX" } }], status: { kind: "aguardando_aprovacao", instrucao: "Aguardando aprovação, não descarregue" }, decidedBy: null });
    serve("/api/doca", 64, (items, count) => ({ destination: "CD-03", date: "2026-11-11", destinations: ["CD-03"], items, nextCursor: items.length >= 29 ? "30" : null, total: count, aggregates: { awaiting: 4 - decided.size } }), dockItem);
    window.history.replaceState(null, "", "/doca"); // ADR-004
    render(<Frame context={fallbackContext("coordenacao@jachegou.test")} />);
    await waitFor(() => expect(noteRows()).toHaveLength(30));
    expect(screen.getByText("4 notas aguardam aprovação.")).toBeTruthy();
    fireEvent.click(screen.getByText("NF 1"));
    await decide();
    await waitFor(() => expect(noteRows()).toHaveLength(29));
    expect(screen.getByText("63 notas")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("3 notas aguardam aprovação.")).toBeTruthy());
    expect(document.querySelectorAll("tbody tr")).toHaveLength(29);
  });
});
