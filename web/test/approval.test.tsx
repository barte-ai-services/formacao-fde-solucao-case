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
  exceptionCode: "E6",
  exceptionName: "Duplicidade",
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
    { classification: "E6", exceptionCode: "E6", exceptionName: "Duplicidade", skus: ["SKU-1"], evidence: [{ source: "erp_contas_a_pagar", reference: "NF-77", description: "Mesma ordem já lançada" }] },
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

describe("#128 exceção pelo nome na fila", () => {
  it("AC-1 e AC-2: o selo mostra o nome e o código fica na coluna Código", async () => {
    respond = () => Response.json({ approver: { email: "c", level: "coordenacao" }, items: [item()] });
    renderAt("/pagar/fila");
    const row = (await screen.findByText("NF 80 · F12")).closest("tr") as HTMLElement;
    expect(within(row).getByText("Duplicidade")).toBeTruthy();
    expect(within(row).getByText("E6")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Código" })).toBeTruthy();
  });

  it("AC-4: a tela mostra o nome que a API mandou, sem traduzir o código", async () => {
    respond = () =>
      Response.json({ approver: { email: "c", level: "coordenacao" }, items: [item({ exceptionName: "Nome da API" })] });
    renderAt("/pagar/fila");
    expect(await screen.findByText("Nome da API")).toBeTruthy();
    expect(screen.queryByText("Duplicidade")).toBeNull();
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
    fireEvent.click(await screen.findByRole("radio", { name: /^Recusar/ }));
    fireEvent.click(screen.getByRole("button", { name: "Registrar a decisão" }));
    expect(await screen.findByText("Decisão registrada")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === `/api/propostas/${KEY}/aprovar`)).toBe(true);
  });

  it("AC-9: alterar sem justificativa não chega à API", async () => {
    respond = () => Response.json(detail());
    renderAt(`/pagar/fila/${KEY}`);
    fireEvent.click(await screen.findByRole("radio", { name: /^Receber(?! parcial)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Registrar a decisão" }));
    await screen.findByRole("heading", { name: /Proposta da nota/ });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("AC-8: a segunda decisão (409) aparece como já decidida", async () => {
    respond = (method) => (method === "POST" ? Response.json({ error: "ja_decidida" }, { status: 409 }) : Response.json(detail()));
    renderAt(`/pagar/fila/${KEY}`);
    fireEvent.click(await screen.findByRole("radio", { name: /^Recusar/ }));
    fireEvent.click(screen.getByRole("button", { name: "Registrar a decisão" }));
    expect(await screen.findByText(/já foi decidida/)).toBeTruthy();
  });
});

// #68: o dossiê do Claude na gaveta da proposta, entre a evidência e a decisão, como no wireframe.
const READY_DOSSIER = {
  status: "ready",
  summary: "A mesma compra já foi cobrada na NF 77.",
  divergences: [
    {
      classification: "E6",
      exceptionCode: "E6",
      exceptionName: "Duplicidade",
      whatDiverges: "A ordem já tem nota lançada.",
      evidence: [{ key: "historico.notas_lancadas.quantidade", label: "Notas lançadas", value: "1", source: "history" }],
    },
  ],
  supplierHistory: "Nenhuma duplicidade nos últimos 90 dias.",
  generatedAt: "2026-11-15T12:00:00Z",
  model: "claude-exemplo",
};

const PENDING_NOTICE =
  "Não há dossiê para esta proposta: o dossiê ainda não foi gerado. Decida pelas divergências e evidências da conferência.";

describe("#68 dossiê do Claude na gaveta da proposta", () => {
  it("#38/AC-1 com o dossiê pronto, a gaveta mostra o Dossiê do Claude entre a evidência e a decisão", async () => {
    respond = () => Response.json({ ...detail(), dossier: READY_DOSSIER });
    renderAt(`/pagar/fila/${KEY}`);
    const heading = await screen.findByText("Dossiê do Claude");
    expect(screen.getByText(READY_DOSSIER.summary)).toBeTruthy();
    const evidence = screen.getByText("Mesma ordem já lançada", { exact: false });
    const decision = screen.getByText("Sua decisão");
    expect(evidence.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(decision) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("#38/AC-4 sem dossiê, a gaveta mostra o aviso e a decisão segue pela conferência", async () => {
    respond = () =>
      Response.json({ ...detail(), dossier: { status: "unavailable", reason: "pending", notice: PENDING_NOTICE, generatedAt: null } });
    renderAt(`/pagar/fila/${KEY}`);
    expect(await screen.findByText("Não há dossiê do Claude para esta proposta.")).toBeTruthy();
    expect(screen.getByText(PENDING_NOTICE)).toBeTruthy();
    expect(screen.queryByText("Dossiê do Claude")).toBeNull();
    expect(screen.getByText("Sua decisão")).toBeTruthy();
  });
});

describe("#63 lista do dia", () => {
  it("AC-13: mostra os títulos liberados do dia, com quem aprovou", async () => {
    respond = () =>
      Response.json({
        day: "2026-11-15",
        items: [
          { invoiceAccessKey: KEY, number: "36", supplierId: "F03", amount: money(96_916), invoiceTotal: money(96_916), dueOn: "2026-11-10", dockAction: "receber", approver: "regra", exceptionCode: "MATCH", exceptionName: "Confere" },
        ],
        total: { cents: 96_916 },
      });
    renderAt("/pagar/hoje");
    const row = (await screen.findByText("NF 36 · F03")).closest("tr");
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).getByText("Regra")).toBeTruthy();
  });

  it("#128/AC-1 e AC-2: a exceção aparece pelo nome, e o código numa coluna Código", async () => {
    respond = () =>
      Response.json({
        day: "2026-11-15",
        items: [
          { invoiceAccessKey: KEY, number: "36", supplierId: "F03", amount: money(1), invoiceTotal: money(1), dueOn: "2026-11-10", dockAction: "receber", approver: "regra", exceptionCode: "E4", exceptionName: "Unidade de medida" },
        ],
        total: { cents: 1 },
      });
    renderAt("/pagar/hoje");
    const row = (await screen.findByText("NF 36 · F03")).closest("tr") as HTMLElement;
    expect(within(row).getByText("Unidade de medida")).toBeTruthy();
    expect(within(row).getByText("E4")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Código" })).toBeTruthy();
  });
});

describe("#133 fila: Encaminhada a e Minhas", () => {
  const queue = () =>
    Response.json({
      approver: { email: "c", level: "coordenacao" },
      items: [
        item(),
        item({ invoiceAccessKey: "2".repeat(44), number: "81", requiredApproverLevel: "diretoria", level: "diretoria", canApprove: false }),
      ],
    });

  it("AC-1 e AC-2: sem a coluna Você aprova?, com Encaminhada a pelo nome do glossário", async () => {
    respond = queue;
    renderAt("/pagar/fila");
    expect(await screen.findByText("NF 80 · F12")).toBeTruthy();
    expect(screen.queryByText("Você aprova?")).toBeNull();
    expect(screen.getByText("Encaminhada a")).toBeTruthy();
    expect(screen.getAllByText("Diretoria").length).toBeGreaterThan(0);
  });

  it("AC-3: a linha que não decide fica esmaecida com a dica, e Minhas mostra só as decidíveis", async () => {
    respond = queue;
    renderAt("/pagar/fila");
    await screen.findByText("NF 80 · F12");
    expect(document.querySelectorAll(".pagar-dimmed[title='Precisa de Diretoria']").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".pagar-dimmed[title='Precisa de Coordenação']").length).toBe(0);
    fireEvent.click(screen.getByRole("radio", { name: /Minhas/ }));
    expect(screen.getByText("NF 80 · F12")).toBeTruthy();
    expect(screen.queryByText(/NF 81/)).toBeNull();
  });
});

describe("#129 chave de acesso na gaveta", () => {
  it("AC-1 e AC-3: a chave inteira numa linha só e o botão de copiar entrega a chave", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    respond = () => Response.json(detail());
    renderAt(`/pagar/fila/${KEY}`);
    const key = await screen.findByText(KEY);
    expect(key.className).toContain("pagar-access-key__value");
    fireEvent.click(screen.getByRole("button", { name: "Copiar chave" }));
    expect(writeText).toHaveBeenCalledWith(KEY);
  });
});

describe("#129 AC-2 largura da gaveta por token", () => {
  it("a largura vem de uma variável, não de um valor solto", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/app.css", "utf8");
    expect(css).toMatch(/--pagar-drawer-width:\s*5[0-3]0px/);
    expect(css).toMatch(/\.shell-connection-panel\s*{\s*width:\s*var\(--pagar-drawer-width\)/);
  });
});
