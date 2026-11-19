import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { fallbackContext } from "../src/shell/context";

/*
 * #160 Acessibilidade no nível da página, nas telas montadas pelo `Frame` (a fila e a doca), com o que só a composição mostra: marcos, ordem dos
 * títulos, a caixa que rola como região com nome, a ordem do Tab entre o filtro e as linhas, o esqueleto fora do Tab e da leitura, a faixa de erro
 * do bloco que o teclado alcança. O repositório não tem axe: segue o padrão de web/test/auditor-gaveta-a11y.test.tsx, com papéis e nomes
 * acessíveis do Testing Library. O IntersectionObserver é simulado e disparado pelo teste.
 */

class FakeObserver {
  static live: FakeObserver[] = [];
  readonly targets: Element[] = [];
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeObserver.live.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    FakeObserver.live = FakeObserver.live.filter((o) => o !== this);
    this.targets.length = 0;
  }
  fire() {
    // #160 o jsdom não tem IntersectionObserverEntry: a entrada parcial só carrega o que a tabela lê
    const entries = this.targets.map((target) => ({ isIntersecting: true, target }) as unknown as IntersectionObserverEntry);
    // #160 o observador simulado não implementa o resto da interface real; o teste só chama o callback
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

async function reachEnd() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  await act(async () => {
    FakeObserver.live.filter((o) => o.targets.length > 0).forEach((o) => o.fire());
  });
}

const money = (cents: number) => ({ cents, text: `R$ ${(cents / 100).toFixed(2).replace(".", ",")}` });
const KEY = (n: number) => `352611000000000000005500100000${String(n).padStart(8, "0")}1000`;
const queueItem = (n: number) => ({
  invoiceAccessKey: KEY(n), number: String(n), supplierId: "F12", store: "LJ-001", issuedOn: "2026-11-10", total: money(100_000), classification: "E6", exceptionCode: "E6", exceptionName: "Duplicidade", level: "bloqueio", line: 1, reason: "x", requiredApproverLevel: "coordenacao", amountAtRisk: money(50_000), dockAction: { kind: "recusar" }, state: "aguardando_aprovacao", canApprove: true,
});
const dockItem = (n: number) => ({
  invoiceAccessKey: `r${n}`, number: String(n), supplierId: "F08", items: [{ sku: "SKU-1025", description: "Macarrão espaguete 500 g", quantity: { amount: 232, unit: "CX" } }], status: { kind: "acao", action: { kind: "receber" }, publishedAt: "2026-11-11T09:00:00Z" }, decidedBy: null,
});

/** #160 Uma lista de 70 notas em blocos de 30; `hold` segura o bloco com cursor e `failNext` o faz falhar uma vez. */
function serve(path: string, item: (n: number) => unknown, context: Record<string, unknown>, aggregates: unknown) {
  const control = { hold: null as Promise<void> | null, failNext: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://web.test");
      if (url.pathname.startsWith("/api/propostas/")) return Response.json({ error: "not_found" }, { status: 404 });
      if (url.pathname !== path) return Response.json({ error: "not_found" }, { status: 404 });
      const cursor = url.searchParams.get("cursor");
      if (cursor !== null) {
        if (control.hold) await control.hold;
        if (control.failNext) {
          control.failNext = false;
          return Response.json({ error: "falha" }, { status: 500 });
        }
      }
      const at = cursor === null ? 0 : Number(cursor);
      const items = Array.from({ length: Math.min(30, 70 - at) }, (_, k) => item(at + k + 1));
      return Response.json({ ...context, items, nextCursor: at + 30 < 70 ? String(at + 30) : null, total: 70, aggregates });
    }),
  );
  return control;
}

const renderAt = (path: string) => {
  window.history.replaceState(null, "", path);
  return render(<Frame context={fallbackContext("coordenacao@jachegou.test")} />);
};
const queueAggregates = { all: 70, approvable: 40, amountAtRisk: money(12_345_600), blocked: 12 };
const dockContext = { destination: "CD-03", date: "2026-11-11", destinations: ["CD-03", "CD-04"] };

beforeEach(() => {
  FakeObserver.live = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => vi.unstubAllGlobals());

/** #160 Tudo o que o Tab alcança dentro do conteúdo da página, na ordem do DOM. */
const tabStops = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]')).filter(
    (el) => el.getAttribute("tabindex") !== "-1" && !el.closest('[aria-hidden="true"]'),
  );

describe("#160 acessibilidade da fila montada", () => {
  it("#160/AC-3: um só marco principal, o título da tela antes da tabela e a caixa que rola como região com o nome da lista", async () => {
    serve("/api/fila", queueItem, { approver: { email: "coordenacao@jachegou.test", level: "coordenacao" } }, queueAggregates); // ADR-004
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    const main = screen.getByRole("main");
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(within(main).getAllByRole("heading", { name: "Fila de aprovação" })).toHaveLength(1);
    const region = within(main).getByRole("region", { name: "Fila de aprovação" });
    expect(within(region).getByRole("table")).toBeTruthy();
    // #160 O contador é um aviso educado (status), um só enquanto a lista não acabou
    expect(within(main).getAllByRole("status").filter((el) => el.textContent === "70 notas")).toHaveLength(1);
  });

  it("#160/AC-2: o cabeçalho fixo é de colunas com nome, e cada linha de nota entra no Tab com o seu rótulo", async () => {
    serve("/api/fila", queueItem, { approver: { email: "coordenacao@jachegou.test", level: "coordenacao" } }, queueAggregates); // ADR-004
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.length).toBeGreaterThan(3);
    headers.forEach((th) => expect((th.textContent ?? "").length).toBeGreaterThan(0));
    await waitFor(() => expect(within(table).getAllByRole("row", { name: /^Abrir a nota/ })).toHaveLength(30));
    // #160 Nenhum tabindex positivo: a ordem do Tab é a do DOM, o filtro antes das linhas
    expect(document.querySelectorAll("[tabindex]:not([tabindex='0']):not([tabindex='-1'])")).toHaveLength(0);
    const stops = tabStops(screen.getByRole("main"));
    const firstRow = stops.findIndex((el) => el.tagName === "TR");
    const lastChip = stops.map((el) => el.getAttribute("role")).lastIndexOf("radio");
    expect(lastChip).toBeGreaterThanOrEqual(0);
    expect(lastChip).toBeLessThan(firstRow);
  });

  it("#160/AC-1: enquanto o bloco carrega, o esqueleto não é lido nem entra no Tab, e a tabela mantém o cabeçalho", async () => {
    const api = serve("/api/fila", queueItem, { approver: { email: "coordenacao@jachegou.test", level: "coordenacao" } }, queueAggregates); // ADR-004
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    let release!: () => void;
    api.hold = new Promise<void>((resolve) => (release = resolve));
    await reachEnd();
    await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(33));
    const skeleton = Array.from(document.querySelectorAll("tbody tr")).slice(30);
    skeleton.forEach((tr) => {
      expect(tr.getAttribute("aria-hidden")).toBe("true");
      expect(tr.getAttribute("tabindex")).toBeNull();
    });
    expect(within(screen.getByRole("table")).getAllByRole("columnheader").length).toBeGreaterThan(3);
    expect(tabStops(screen.getByRole("main")).filter((el) => el.tagName === "TR")).toHaveLength(30);
    release();
    await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(60));
  });

  it("#160/AC-1: a falha do bloco vira um alerta com o botão Tentar de novo, alcançável pelo teclado, sem repetir o texto do erro", async () => {
    const api = serve("/api/fila", queueItem, { approver: { email: "coordenacao@jachegou.test", level: "coordenacao" } }, queueAggregates); // ADR-004
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    api.failNext = true;
    await reachEnd();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Não consegui carregar as próximas notas")).toBeTruthy();
    // #160 O que a pessoa lê não traz o código nem o corpo da resposta que falhou
    expect(alert.textContent).not.toMatch(/falha|500/);
    const retry = within(alert).getByRole("button", { name: "Tentar de novo" });
    expect(tabStops(screen.getByRole("main"))).toContain(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("#160/AC-3: no fim da lista o rodapé é um aviso, e o contador do topo segue sendo o mesmo número", async () => {
    serve("/api/fila", queueItem, { approver: { email: "coordenacao@jachegou.test", level: "coordenacao" } }, queueAggregates); // ADR-004
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    await reachEnd();
    await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(60));
    await reachEnd();
    const end = await screen.findByText("Você viu todas as 70 notas");
    expect(end.closest('[role="status"]')).toBeTruthy();
    expect(screen.getByText("70 notas").closest('[role="status"]')).toBeTruthy();
  });
});

describe("#160 acessibilidade da doca montada", () => {
  it("#160/AC-3: marco principal, título, seletor de destino com nome e a caixa da lista como região com nome", async () => {
    serve("/api/doca", dockItem, dockContext, { awaiting: 4 });
    renderAt("/doca"); // ADR-004
    await screen.findByText("NF 1");
    const main = screen.getByRole("main");
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(within(main).getAllByRole("heading", { name: "Doca" })).toHaveLength(1);
    const region = within(main).getByRole("region", { name: "Doca" });
    expect(within(region).getByRole("table")).toBeTruthy();
    // #160 O seletor de destino é um controle com nome: leitor de tela diz de que é a escolha
    expect(within(within(main).getByRole("group", { name: "Trocar a doca" })).getByRole("combobox")).toBeTruthy();
    // #160 O aviso de aguardando fica fora da tabela, no alerta da tela
    expect(within(main).getByText("4 notas aguardam aprovação.")).toBeTruthy();
  });

  it("#160/AC-2: as linhas da doca entram no Tab com rótulo e o esqueleto do próximo bloco não", async () => {
    const api = serve("/api/doca", dockItem, dockContext, { awaiting: 4 });
    renderAt("/doca"); // ADR-004
    await screen.findByText("NF 1");
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row", { name: /^Abrir a nota/ })).toHaveLength(30));
    let release!: () => void;
    api.hold = new Promise<void>((resolve) => (release = resolve));
    await reachEnd();
    await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(33));
    expect(tabStops(screen.getByRole("main")).filter((el) => el.tagName === "TR")).toHaveLength(30);
    release();
    await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(60));
  });
});
