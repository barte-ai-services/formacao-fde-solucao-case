import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { fallbackContext } from "../src/shell/context";

// #63 As telas da aprovação contra uma API falsa, com o formato de api/src/http/approval.ts.

const KEY = "35261100000000000000550010000080001000080001";
const money = (cents: number) => ({ cents, text: `R$ ${(cents / 100).toFixed(2).replace(".", ",")}` });

const item = (overrides: Record<string, unknown> = {}) => ({
  invoiceAccessKey: KEY,
  number: "80",
  supplierId: "F12",
  store: "LJ-001",
  issuedOn: "2026-11-10",
  total: money(771_120),
  classification: "E6",
  level: "bloqueio",
  line: 1,
  reason: "Duplicidade (E6): ninguém paga até a coordenação resolver",
  requiredApproverLevel: "coordenacao",
  amountAtRisk: money(771_120),
  dockAction: { kind: "recusar" },
  state: "aguardando_aprovacao",
  canApprove: true,
  ...overrides,
});

const detail = (overrides: Record<string, unknown> = {}) => ({
  ...item(overrides),
  justification: "Duplicidade: a mesma compra já foi cobrada",
  items: [],
  divergences: [
    { classification: "E6", skus: ["SKU-1"], evidence: [{ source: "erp_contas_a_pagar", reference: "NF-77", description: "Mesma ordem já lançada" }] },
  ],
  title: { state: "lancado", amount: money(771_120), dueOn: "2026-11-10" },
  approval: null,
});

let calls: { method: string; path: string; body: unknown }[] = [];
let respond: (method: string, path: string) => Response;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = String(input);
      calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return respond(method, path);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  return render(<Frame context={fallbackContext("coordenacao@jachegou.test")} />);
}

describe("#63 fila de aprovação", () => {
  it("AC-6: mostra a proposta que aguarda, com nível e valor em risco, e abre a gaveta com a evidência (AC-12)", async () => {
    respond = (_m, path) =>
      path === "/api/fila"
        ? Response.json({ approver: { email: "c", level: "coordenacao" }, items: [item()] })
        : Response.json(detail());
    renderAt("/pagar/fila");
    expect(await screen.findByText("NF 80 · F12")).toBeTruthy();
    expect(screen.getAllByText("Bloqueio").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("NF 80 · F12"));
    expect(await screen.findByText("Mesma ordem já lançada", { exact: false })).toBeTruthy();
    expect(screen.getByText(/Linha 1 da régua/)).toBeTruthy();
    expect(screen.getByText("Sua decisão")).toBeTruthy();
  });

  it("AC-7: quem está abaixo do nível vê a proposta e o aviso, sem o formulário", async () => {
    respond = () => Response.json(detail({ canApprove: false }));
    renderAt(`/pagar/fila/${KEY}`);
    expect(await screen.findByText(/pede o nível coordenação ou acima/)).toBeTruthy();
    expect(screen.queryByText("Sua decisão")).toBeNull();
  });
});

describe("#63 proposta e decisão", () => {
  it("AC-8 e AC-11: aprovar chama a API e mostra a decisão registrada", async () => {
    respond = (method) =>
      method === "POST"
        ? Response.json({
            approval: { approver: "c", approverLevel: "coordenacao", dockAction: { kind: "recusar" }, justification: "x", decidedOn: "2026-11-15" },
            title: { state: "bloqueado", amount: money(771_120) },
          })
        : Response.json(detail());
    renderAt(`/pagar/fila/${KEY}`);
    fireEvent.click(await screen.findByRole("radio", { name: /Aprovar: recusar/ }));
    fireEvent.click(screen.getByRole("button", { name: "Registrar a decisão" }));
    expect(await screen.findByText("Decisão registrada")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === `/api/propostas/${KEY}/aprovar`)).toBe(true);
  });

  it("AC-9: alterar sem justificativa não chega à API", async () => {
    respond = () => Response.json(detail());
    renderAt(`/pagar/fila/${KEY}`);
    fireEvent.click(await screen.findByRole("radio", { name: /Alterar para receber/ }));
    fireEvent.click(screen.getByRole("button", { name: "Registrar a decisão" }));
    await screen.findByRole("heading", { name: /Proposta da nota/ });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("AC-8: a segunda decisão (409) aparece como já decidida", async () => {
    respond = (method) => (method === "POST" ? Response.json({ error: "ja_decidida" }, { status: 409 }) : Response.json(detail()));
    renderAt(`/pagar/fila/${KEY}`);
    fireEvent.click(await screen.findByRole("radio", { name: /Aprovar: recusar/ }));
    fireEvent.click(screen.getByRole("button", { name: "Registrar a decisão" }));
    expect(await screen.findByText(/já foi decidida/)).toBeTruthy();
  });
});

describe("#63 lista do dia", () => {
  it("AC-13: mostra os títulos liberados do dia, com quem aprovou", async () => {
    respond = () =>
      Response.json({
        day: "2026-11-15",
        items: [
          { invoiceAccessKey: KEY, number: "36", supplierId: "F03", amount: money(96_916), invoiceTotal: money(96_916), dueOn: "2026-11-10", dockAction: "receber", approver: "regra" },
        ],
        total: { cents: 96_916 },
      });
    renderAt("/pagar/hoje");
    const row = (await screen.findByText("NF 36 · F03")).closest("tr");
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).getByText("Regra")).toBeTruthy();
  });
});
