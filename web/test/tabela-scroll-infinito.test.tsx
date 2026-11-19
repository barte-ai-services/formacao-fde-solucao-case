import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { fallbackContext } from "../src/shell/context";

/*
 * #160 Esqueleto de ponta a ponta, vermelho, contra o wireframe aprovado (artifacts/wireframe-tabela-scroll-infinito/,
 * aprovado por Fernando Seguim em 18/11/2026, com D1 a D4). Monta as telas reais pelo `Frame`, com `fetch` simulado no
 * contrato paginado de api/README.md (`items`, `nextCursor`, `total`, `aggregates`) e um IntersectionObserver simulado que
 * o teste dispara. Os textos são os do wireframe. Não há Playwright no repositório: o "ponta a ponta" daqui é vitest + jsdom.
 *
 * O esqueleto nasceu vermelho (cada caso em `it.fails`, para o `make check` ficar verde com a tabela por construir) e foi virando `it(...)` conforme
 * a camada indicada o satisfazia; na camada de contrato os últimos viraram, e nenhum `it.fails` sobra. Duas correções de teste feitas aqui, ambas
 * sem afrouxar asserção: o `Stat` é achado pelo título dentro do Stat (`stat(...)`, porque "A pagar", "Por quê" e "Aguardando aprovação" também
 * são cabeçalho de coluna e selo de linha), e o disparo do observador e a contagem das linhas esperam o efeito que as liga (corrida vista em 1 de 8 rodadas).
 * Nome dos casos: `#160/AC-n:`. D3 e D4 não são AC; levam o AC que mais se aproxima (D3 e a faixa de erro do bloco: AC-1;
 * o filtro e o `cursor_invalido`: AC-1, porque recomeçam a busca por blocos).
 */


class FakeObserver {
  static live: FakeObserver[] = [];
  readonly targets: Element[] = [];
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeObserver.live.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve(target: Element) {
    this.targets.splice(this.targets.indexOf(target), 1);
  }
  disconnect() {
    FakeObserver.live = FakeObserver.live.filter((o) => o !== this);
    this.targets.length = 0;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  fire() {
    // #160 o jsdom não tem IntersectionObserverEntry: a entrada parcial só carrega o que a tabela lê (`isIntersecting`, `target`)
    const entries = this.targets.map((target) => ({ isIntersecting: true, target }) as unknown as IntersectionObserverEntry);
    // #160 o observador simulado não implementa o resto da interface real (`root`, `thresholds`); o teste só chama o callback
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

/**
 * #160 O teste "rola até perto do fim": dispara a interseção em todo observador vivo que ainda olha algo. O observador novo nasce num efeito
 * (a cada bloco, a tabela refaz a observação) e o `findBy`/`waitFor` pode voltar antes de ele rodar: sem esperar o efeito, o disparo caía no
 * vazio e o teste falhava de vez em quando (a doca, uma em oito rodadas). O navegador real avisa ao observar; o simulado, não.
 */
async function reachEnd() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  await act(async () => {
    FakeObserver.live.filter((o) => o.targets.length > 0).forEach((o) => o.fire());
  });
}


interface Api {
  calls: string[];
  /** #160 Os pedidos de lista (GET sem ser a proposta), na ordem. */
  lists: () => URL[];
  /** #160 Enquanto houver uma promessa aqui, a próxima busca COM cursor espera por ela. */
  hold: Promise<void> | null;
  /** #160 Cursores que falham uma vez com 500. */
  failOnce: Set<string>;
  /** #160 O próximo pedido com cursor responde 400 cursor_invalido, uma vez. */
  invalidOnce: boolean;
  /** #160 Linhas já decididas pela gaveta (D3): a API deixa de mandá-las e os agregados descem. */
  decided: Set<string>;
}

interface ListSpec {
  path: string;
  total: number;
  pageSize?: number;
  item: (i: number) => { key: string } & Record<string, unknown>;
  /** #160 O corpo, dado o bloco, o `nextCursor`, o `total` e quantas já saíram da lista (D3). */
  body: (page: { items: unknown[]; nextCursor: string | null; total: number }, api: Api, mode: string) => unknown;
  /** #160 O total de cada modo de filtro (a fila: `pode_aprovar=1`). */
  totalFor?: (mode: string) => number;
  detail?: (key: string) => unknown;
}

function serve(spec: ListSpec): Api {
  const api: Api = { calls: [], lists: () => [], hold: null, failOnce: new Set(), invalidOnce: false, decided: new Set() };
  api.lists = () => api.calls.filter((c) => c.startsWith(spec.path)).map((c) => new URL(c, "http://web.test"));
  const size = spec.pageSize ?? 30;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input);
      api.calls.push(path);
      if (path.startsWith("/api/supplier-requests/")) return Response.json({ request: null });
      if (path.startsWith("/api/propostas/")) {
        if (init.method === "POST") {
          const key = decodeURIComponent(path.split("/")[3]!);
          api.decided.add(key);
          return Response.json({ approval: { approver: "c", approverLevel: "coordenacao", dockAction: { kind: "recusar" }, justification: "x", decidedOn: "2026-11-15" }, title: { state: "bloqueado", amount: { cents: 1, text: "R$ 0,01" } } });
        }
        return Response.json(spec.detail?.(decodeURIComponent(path.split("/")[3]!)) ?? { error: "not_found" }, spec.detail ? undefined : { status: 404 });
      }
      if (!path.startsWith(spec.path)) return Response.json({ error: "not_found" }, { status: 404 });
      const url = new URL(path, "http://web.test");
      const mode = url.searchParams.get("pode_aprovar") === "1" ? "mine" : "all";
      const cursor = url.searchParams.get("cursor");
      // #160 sem `cursor` e sem `limite` a API responde na forma antiga (api/README.md, "Dois modos"), que este fake não imita: erro claro, para o teste não passar por engano
      if (cursor === null && url.searchParams.get("limite") === null) return Response.json({ error: "fake_sem_forma_antiga" }, { status: 501 });
      if (cursor !== null) {
        if (api.hold) await api.hold;
        if (api.invalidOnce || !cursor.startsWith(`${mode}:`)) {
          api.invalidOnce = false;
          return Response.json({ error: "cursor_invalido" }, { status: 400 });
        }
        if (api.failOnce.delete(cursor)) return Response.json({ error: "falha" }, { status: 500 });
      }
      const offset = cursor === null ? 0 : Number(cursor.split(":")[1]);
      const everything = spec.totalFor?.(mode) ?? spec.total;
      const total = everything - api.decided.size;
      const ids = Array.from({ length: Math.min(size, everything - offset) }, (_, k) => offset + k + 1).filter((i) => !api.decided.has(spec.item(i).key));
      const next = offset + size < everything ? `${mode}:${offset + size}` : null;
      return Response.json(spec.body({ items: ids.map(spec.item), nextCursor: next, total }, api, mode));
    }),
  );
  return api;
}

/** #160 o pedido de um primeiro bloco traz `limite` entre 25 e 50 (api/README.md), senão a API responde na forma antiga. */
function expectPaged(url: URL) {
  const limit = Number(url.searchParams.get("limite"));
  expect(Number.isInteger(limit) && limit >= 25 && limit <= 50).toBe(true);
  expect(url.searchParams.get("cursor")).toBeNull();
}

function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  return render(<Frame context={fallbackContext("coordenacao@jachegou.test")} />);
}

const money = (cents: number) => ({ cents, text: `R$ ${(cents / 100).toFixed(2).replace(".", ",")}` });
/**
 * #160 O Stat do topo pelo título dele. O mesmo texto também é cabeçalho de coluna ("A pagar", "Por quê") e selo de linha ("Aguardando
 * aprovação", na gaveta): `getByText` achava mais de um assim que a tabela existia, e só o Stat guarda o número dos agregados.
 */
const stat = (caption: string): string => screen.getAllByText(caption).find((el) => /Stat-module__caption/.test(el.className))!.closest("div")!.textContent ?? "";
const rows = () => Array.from(document.querySelectorAll("tbody tr"));
/** #160 Linhas de nota de verdade: as de esqueleto não levam o rótulo "Abrir…". */
const noteRows = () => rows().filter((tr) => (tr.getAttribute("aria-label") ?? "").length > 0 && !/Carregando/.test(tr.getAttribute("aria-label")!));

beforeEach(() => {
  FakeObserver.live = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => vi.unstubAllGlobals());


const KEY = (n: number) => `352611000000000000005500100000${String(n).padStart(8, "0")}1000`;
const queueItem = (n: number) => ({
  key: KEY(n),
  invoiceAccessKey: KEY(n),
  number: String(n),
  supplierId: "F12",
  store: "LJ-001",
  issuedOn: "2026-11-10",
  total: money(100_000),
  classification: "E6",
  exceptionCode: "E6",
  exceptionName: "Duplicidade",
  level: "bloqueio",
  line: 1,
  reason: "Duplicidade (E6)",
  requiredApproverLevel: "coordenacao",
  amountAtRisk: money(50_000),
  dockAction: { kind: "recusar" },
  state: "aguardando_aprovacao",
  canApprove: true,
});
const queueDetail = (key: string) => ({
  ...queueItem(Number(key.slice(30, 38))),
  justification: "Duplicidade: a mesma compra já foi cobrada",
  items: [],
  divergences: [{ classification: "E6", exceptionCode: "E6", exceptionName: "Duplicidade", skus: ["SKU-1"], evidence: [{ source: "erp_contas_a_pagar", reference: "NF-77", description: "Mesma ordem já lançada" }] }],
  title: { state: "lancado", amount: money(100_000), dueOn: "2026-11-10" },
  approval: null,
});

/** #160 70 notas em blocos de 30: 30, 30 e 10. Agregados da lista inteira: 70 aguardando, 12 bloqueadas, R$ 123.456 em risco. */
function serveQueue(): Api {
  return serve({
    path: "/api/fila", // ADR-004
    total: 70,
    item: queueItem,
    totalFor: (mode) => (mode === "mine" ? 40 : 70),
    detail: queueDetail,
    body: ({ items, nextCursor, total }, api) => ({
      approver: { email: "coordenacao@jachegou.test", level: "coordenacao" },
      items,
      nextCursor,
      total,
      // #160 O chip "Minhas" não muda os agregados (api/README.md); decidir uma nota os reduz (D3).
      aggregates: { all: 70 - api.decided.size, approvable: 40 - api.decided.size, amountAtRisk: { cents: 12_345_600 - 50_000 * api.decided.size, text: "R$ 123.456,00" }, blocked: 12 },
    }),
  });
}

describe("#160 fila de aprovação com scroll infinito", () => {
  it("#160/AC-3: mostra o primeiro bloco e o contador de notas no topo", async () => {
    const api = serveQueue();
    renderAt("/pagar/fila"); // ADR-004
    expect(await screen.findByText("NF 1")).toBeTruthy();
    expectPaged(api.lists()[0]!);
    await waitFor(() => expect(noteRows()).toHaveLength(30)); // #160 o rótulo da linha entra num efeito do RowTable, depois de o texto da nota aparecer
    // #160 O contador é a `total` da API (70), não as 30 que carregaram.
    expect(screen.getByText("70 notas").closest('[role="status"]')).toBeTruthy();
  });
  it("#160/AC-4: os números do topo vêm dos agregados da API, não do que carregou", async () => {
    serveQueue();
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    // #160 Aguardando = aggregates.all (70, e não as 30 linhas); bloqueadas = aggregates.blocked (12); risco = aggregates.amountAtRisk.
    expect(stat("Aguardando aprovação")).toContain("70");
    expect(stat("Bloqueadas por duplicidade")).toContain("12");
    expect(stat("Valor em risco na fila")).toMatch(/123\.456/);
  });
  it("#160/AC-1: perto do fim busca o próximo bloco pelo nextCursor e mostra esqueleto enquanto carrega", async () => {
    const api = serveQueue();
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    let release!: () => void;
    api.hold = new Promise<void>((r) => (release = r));
    await reachEnd();
    // #160 Pendente: o cursor do primeiro bloco foi pedido, e três linhas de esqueleto ficam abaixo da última nota.
    await waitFor(() => expect(api.lists().at(-1)!.searchParams.get("cursor")).toBe("all:30"));
    expect(rows()).toHaveLength(33);
    await waitFor(() => expect(noteRows()).toHaveLength(30)); // #160 o rótulo da linha entra num efeito do RowTable, depois de o texto da nota aparecer
    // #160 O esqueleto não é linha de nota: não entra no Tab e não abre a gaveta.
    const skeleton = rows().slice(30);
    skeleton.forEach((tr) => expect(tr.getAttribute("tabindex")).toBeNull());
    fireEvent.click(skeleton[0]!);
    expect(api.calls.some((c) => c.startsWith("/api/propostas/"))).toBe(false);
    api.hold = null;
    release();
    await waitFor(() => expect(noteRows()).toHaveLength(60));
    expect(rows()).toHaveLength(60);
  });
  it("#160/AC-1: o gatilho olha a caixa da tabela (root), que contém o cabeçalho e as linhas", async () => {
    serveQueue();
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    // #160 o observador nasce num efeito, depois de o texto da nota aparecer
    await waitFor(() => expect(FakeObserver.live.some((o) => o.targets.length > 0)).toBe(true));
    const observer = FakeObserver.live.find((o) => o.targets.length > 0)!;
    const root = observer.options.root as Element;
    expect(root.querySelector("thead")).toBeTruthy();
    expect(root.querySelector("tbody tr")).toBeTruthy();
  });
  it("#160/AC-3: no último bloco (nextCursor nulo) o rodapé diz \"Você viu todas as 70 notas\" e nada mais é buscado", async () => {
    const api = serveQueue();
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    await reachEnd();
    await waitFor(() => expect(noteRows()).toHaveLength(60));
    await reachEnd();
    await waitFor(() => expect(noteRows()).toHaveLength(70));
    expect(await screen.findByText("Você viu todas as 70 notas")).toBeTruthy();
    const before = api.calls.length;
    await reachEnd();
    expect(api.calls.length).toBe(before);
  });
  it("#160/AC-4: os números do topo ficam os mesmos depois do segundo bloco", async () => {
    serveQueue();
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    const top = () => [stat("Aguardando aprovação"), stat("Valor em risco na fila"), stat("Bloqueadas por duplicidade"), screen.getByText("70 notas").textContent];
    const before = top();
    await reachEnd();
    await waitFor(() => expect(noteRows()).toHaveLength(60));
    expect(top()).toEqual(before);
  });

  // #160 Camada de componentes: a regra do app.css (`.pagar-scroll ... thead th`) o satisfaz, então virou it(...). É o AC-2; no jsdom afirma-se a regra
  // #160 (por token, sem px solto), como web/test/tabelas-estilo.test.ts; a medida no navegador fica no relato da camada.
  it("#160/AC-2: o cabeçalho da tabela fica fixo na caixa que rola, por token do design system", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const sticky = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel, body]) => /thead\s+th/.test(sel!) && /position:\s*sticky/.test(body!) && /top:\s*0/.test(body!));
    expect(sticky.length).toBeGreaterThan(0);
    // #160 O z-index vem de uma variável com ponteiro, não de um número solto; a cor, de um token.
    const body = sticky.map(([, , b]) => b).join("\n");
    expect(body).toMatch(/z-index:\s*var\(/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  it("#160/AC-1: se um bloco falha, a faixa oferece \"Tentar de novo\", que repete o mesmo cursor sem perder o carregado", async () => {
    const api = serveQueue();
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    api.failOnce.add("all:30");
    await reachEnd();
    expect(await screen.findByText("Não consegui carregar as próximas notas")).toBeTruthy();
    await waitFor(() => expect(noteRows()).toHaveLength(30)); // #160 o rótulo da linha entra num efeito do RowTable, depois de o texto da nota aparecer
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(noteRows()).toHaveLength(60));
    const cursors = api.lists().map((u) => u.searchParams.get("cursor"));
    expect(cursors.filter((c) => c === "all:30")).toHaveLength(2);
    expect(screen.getByText("70 notas")).toBeTruthy();
  });
  it("#160/AC-1: trocar o filtro para \"Minhas\" recarrega do primeiro bloco, com pode_aprovar=1, e os números do topo ficam", async () => {
    const api = serveQueue();
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    await reachEnd();
    await waitFor(() => expect(noteRows()).toHaveLength(60));
    fireEvent.click(screen.getByRole("radio", { name: /Minhas/ }));
    const last = () => api.lists().at(-1)!;
    await waitFor(() => expect(last().searchParams.get("pode_aprovar")).toBe("1"));
    expectPaged(last());
    // #160 A lista recomeça: 30 linhas do primeiro bloco do filtro, e o contador passa a ser o da lista filtrada.
    await waitFor(() => expect(noteRows()).toHaveLength(30));
    expect(screen.getByText("40 notas")).toBeTruthy();
    // #160 Os agregados não mudam com o chip (api/README.md): o Stat continua em 70.
    expect(stat("Aguardando aprovação")).toContain("70");
  });
  it("#160/AC-1: cursor_invalido recomeça a lista do início, uma vez, com o aviso de uma linha", async () => {
    const api = serveQueue();
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    api.invalidOnce = true;
    await reachEnd();
    expect(await screen.findByText("A lista mudou e voltou ao início. Recomeçamos do início; nada que você decidiu se perdeu.")).toBeTruthy();
    // #160 Recomeçou: o último pedido não tem cursor, e a lista é o primeiro bloco de novo.
    await waitFor(() => expect(api.lists().at(-1)!.searchParams.get("cursor")).toBeNull());
    expectPaged(api.lists().at(-1)!);
    await waitFor(() => expect(noteRows()).toHaveLength(30));
  });
  it("#160/AC-4: decidir na gaveta tira a linha e atualiza os números do topo, sem voltar ao início", async () => {
    const api = serveQueue();
    renderAt("/pagar/fila"); // ADR-004
    await screen.findByText("NF 1");
    await reachEnd();
    await waitFor(() => expect(noteRows()).toHaveLength(60));
    fireEvent.click(screen.getByText("NF 1"));
    fireEvent.click(await screen.findByRole("radio", { name: /^Recusar/ }));
    fireEvent.click(screen.getByRole("button", { name: "Registrar a decisão" }));
    expect(await screen.findByText("Decisão registrada")).toBeTruthy();
    // #160 A linha decidida sai, as outras 59 continuam (o segundo bloco não foi descartado), e os números descem em um.
    await waitFor(() => expect(noteRows()).toHaveLength(59));
    expect(screen.getByText("69 notas")).toBeTruthy();
    expect(stat("Aguardando aprovação")).toContain("69");
    // #160 não voltou ao início: nenhum esqueleto de recarga, nenhuma linha a mais além das 59
    expect(rows()).toHaveLength(59);
    // #160 o contrato não fixa como os números se atualizam (rebuscar o primeiro bloco só para ler `total` e `aggregates`, ou ajustar localmente): vale a lista carregada seguir inteira, com a NF 60 do segundo bloco
    expect(screen.getByText("NF 60")).toBeTruthy();
  });
});


describe("#160 lista do dia com scroll infinito", () => {
  const todayItem = (n: number) => ({
    key: `h${n}`,
    invoiceAccessKey: `h${n}`,
    number: String(n),
    supplierId: "F12",
    amount: money(10_000),
    invoiceTotal: money(20_000),
    dueOn: "2026-11-15",
    exceptionCode: "E3",
    exceptionName: "Preço divergente",
    dockAction: "receber",
    approver: n % 2 ? "regra" : "ana@jachegou.test",
    approvedBy: n % 2 ? "rule" : "person",
  });
  const serveToday = () =>
    serve({
      path: "/api/hoje",
      total: 87,
      item: todayItem,
      body: ({ items, nextCursor, total }) => ({ day: "2026-11-15", items, nextCursor, total, aggregates: { toPay: { cents: 8_700_000, text: "R$ 87.000,00" }, approvedByRule: 44 } }),
    });
  it("#160/AC-4: mostra o primeiro bloco, o contador e os números do topo dos agregados (títulos = total, a pagar, pela regra)", async () => {
    const api = serveToday();
    renderAt("/pagar/hoje"); // ADR-004
    expect(await screen.findByText("NF 1")).toBeTruthy();
    expectPaged(api.lists()[0]!);
    await waitFor(() => expect(noteRows()).toHaveLength(30)); // #160 o rótulo da linha entra num efeito do RowTable, depois de o texto da nota aparecer
    expect(screen.getByText("87 notas")).toBeTruthy();
    expect(stat("Títulos na lista")).toContain("87");
    expect(stat("A pagar")).toContain("R$ 87.000,00");
    expect(stat("Liberados pela regra")).toContain("44");
  });
  it("#160/AC-3: rola por três blocos (30, 30, 27) e termina em \"Você viu todas as 87 notas\"", async () => {
    serveToday();
    renderAt("/pagar/hoje"); // ADR-004
    await screen.findByText("NF 1");
    await reachEnd();
    await waitFor(() => expect(noteRows()).toHaveLength(60));
    await reachEnd();
    await waitFor(() => expect(noteRows()).toHaveLength(87));
    expect(await screen.findByText("Você viu todas as 87 notas")).toBeTruthy();
    expect(screen.getByText("87 notas")).toBeTruthy();
  });
});


describe("#160 duplicadas com scroll infinito", () => {
  const dupItem = (n: number) => ({
    key: `d${n}`,
    duplicate: { accessKey: `d${n}`, number: String(n), supplierId: "FORN-07", issuedOn: "2026-11-10", totalCents: 120_960, total: "R$ 1.209,60" },
    original: { accessKey: `o${n}`, number: String(n + 1000), status: "lançada" },
    reason: n % 2 ? "titulo_lancado" : "ordem_sem_saldo",
    titleState: "bloqueado",
    blockedAmountCents: 120_960,
    blockedAmount: "R$ 1.209,60",
  });
  const serveDup = () =>
    serve({
      path: "/api/duplicates",
      total: 65,
      item: dupItem,
      // #160 No modo paginado a lista se chama `items`, não `duplicates` (api/README.md).
      body: ({ items, nextCursor, total }) => ({ items, nextCursor, total, aggregates: { blockedAmount: { cents: 7_862_400, text: "R$ 78.624,00" }, byReason: { titulo_lancado: 33, ordem_sem_saldo: 32 } } }),
    });
  it("#160/AC-4: mostra o primeiro bloco, o contador e os números do topo dos agregados (duplicadas = total, valor evitado, por quê)", async () => {
    const api = serveDup();
    renderAt("/pagar/duplicadas"); // ADR-004
    await waitFor(() => expect(noteRows()).toHaveLength(30));
    expectPaged(api.lists()[0]!);
    expect(screen.getByText("65 notas")).toBeTruthy();
    expect(stat("Duplicadas")).toContain("65");
    expect(stat("Pagamento em dobro evitado")).toContain("R$ 78.624,00");
    expect(stat("Por quê")).toContain("33 · 32");
  });
  it("#160/AC-3: o último bloco encerra com \"Você viu todas as 65 notas\" e os números do topo não mudam", async () => {
    serveDup();
    renderAt("/pagar/duplicadas"); // ADR-004
    await waitFor(() => expect(screen.getByText("65 notas")).toBeTruthy());
    const before = stat("Duplicadas");
    await reachEnd();
    await waitFor(() => expect(noteRows()).toHaveLength(60));
    await reachEnd();
    await waitFor(() => expect(noteRows()).toHaveLength(65));
    expect(await screen.findByText("Você viu todas as 65 notas")).toBeTruthy();
    expect(stat("Duplicadas")).toBe(before);
  });
});


describe.each([
  ["doca", "/doca", "/api/doca", "CD-03"], // ADR-004
  ["recebimento na loja", "/recebimento/loja", "/api/recebimento-loja", "LJ-012"], // ADR-004
])("#160 %s com scroll infinito", (_name, route, path, destination) => {
  const dockItem = (n: number) => ({
    key: `r${n}`,
    invoiceAccessKey: `r${n}`,
    number: String(n),
    supplierId: "F08",
    items: [{ sku: "SKU-1025", description: "Macarrão espaguete 500 g", quantity: { amount: 232, unit: "CX" } }],
    status: { kind: "acao", action: { kind: "receber" }, publishedAt: "2026-11-11T09:00:00Z" },
  });
  const serveDock = () =>
    serve({
      path,
      total: 64,
      item: dockItem,
      body: ({ items, nextCursor, total }) => ({ destination, date: "2026-11-11", destinations: [destination, "X-99"], items, nextCursor, total, aggregates: { awaiting: 4 } }),
    });
  it("#160/AC-4: mostra o primeiro bloco, o contador e o aviso de aguardando vindo de aggregates.awaiting", async () => {
    const api = serveDock();
    renderAt(route);
    expect(await screen.findByText("NF 1")).toBeTruthy();
    expectPaged(api.lists()[0]!);
    await waitFor(() => expect(noteRows()).toHaveLength(30)); // #160 o rótulo da linha entra num efeito do RowTable, depois de o texto da nota aparecer
    expect(screen.getByText("64 notas")).toBeTruthy();
    // #160 4 é o destino inteiro (aggregates.awaiting); as 30 linhas carregadas têm 0 aguardando.
    expect(screen.getByText("4 notas aguardam aprovação.")).toBeTruthy();
  });
  it("#160/AC-3: busca o segundo bloco pelo nextCursor e termina em \"Você viu todas as 64 notas\"", async () => {
    const api = serveDock();
    renderAt(route);
    await screen.findByText("NF 1");
    await reachEnd();
    await waitFor(() => expect(api.lists().at(-1)!.searchParams.get("cursor")).toBe("all:30"));
    await waitFor(() => expect(noteRows()).toHaveLength(60));
    await reachEnd();
    await waitFor(() => expect(noteRows()).toHaveLength(64));
    expect(await screen.findByText("Você viu todas as 64 notas")).toBeTruthy();
  });
});
