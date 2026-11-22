import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../App";
import { POLL_MS } from "../components/useLiveFeed";
import { fallbackContext } from "../shell/context";

/*
 * #355 A tela Ao vivo (/pagar/ao-vivo) contra o wireframe aprovado: o esqueleto que nasceu vermelho e está verde desde a camada do
 * contrato. Roda a tela inteira pelo Frame, como o usuário a abre, com o fetch simulado. Os textos entre aspas são literais do
 * wireframe, de propósito: o teste não lê `texts.aoVivo`, e assim pega a troca de um texto da tela.
 */

const KEY = (n: number) => `3526110000000000000055001000${String(n).padStart(8, "0")}1000`;
const money = (cents: number) => ({ cents, text: `R$ ${(cents / 100).toFixed(2).replace(".", ",")}` });

/** #355 A hora do passo em Brasília (UTC-3): 13:21Z é 10h21. */
const at = (hhmm: string) => `2026-11-20T${hhmm}:00.000Z`;

const RUN = { kind: "run", at: at("13:15"), actor: "system", actor_name: "Automático", invoice: null, status: "ok", step: "Rodada: 12 vistas, 4 propostas, 3 pela regra" };
const RULE = { kind: "decision", at: at("13:21"), actor: "rule", actor_name: "Regra", invoice: { access_key: KEY(51234), number: "51234" }, mode: "delegated", step: "Regra aprovou" };
const ENGINE = { kind: "decision", at: at("13:21"), actor: "engine", actor_name: "Motor", invoice: { access_key: KEY(51234), number: "51234" }, mode: "shadow", step: "Motor, em sombra, aprovaria" };
const PERSON = { kind: "human_decision", at: at("13:19"), actor: "person", actor_name: "Ana Souza", invoice: { access_key: KEY(51220), number: "51220" }, step: "Decidiu a proposta" };
const NEWER = { kind: "decision", at: at("13:23"), actor: "rule", actor_name: "Regra", invoice: { access_key: KEY(51240), number: "51240" }, mode: "delegated", step: "Regra aprovou" };

// #355 74% de propósito diferente do que sairia de decided/byRule: a tela mostra o que a API disse, sem recalcular (AC-3).
const indicators = (pct: number | null) => ({
  day: { date: "2026-11-20", decided: 10, byRule: 3, withoutPersonPct: pct, medianSeconds: { withoutPerson: 60, withPerson: 600 } },
  month: { month: "2026-11", decided: 100, byRule: 30, withoutPersonPct: 40, medianSeconds: { withoutPerson: 60, withPerson: 600 } },
});

const SINCE_1 = "2026-11-20T13:21:00.123456+00:00";
const SINCE_2 = "2026-11-20T13:23:00.654321+00:00";
const FIRST = { events: [RULE, ENGINE, PERSON, RUN], since: SINCE_1, indicators: indicators(74), awaiting: 6 };

/** #355 A proposta que a gaveta lê (a mesma gaveta da fila). */
const proposal = (key: string) => ({
  invoiceAccessKey: key, number: key.slice(-12, -4).replace(/^0+/, ""), supplierId: "F12", store: "CD-01", issuedOn: "2026-11-10", total: money(100_000), classification: "E3", exceptionCode: "E3", exceptionName: "Falta de mercadoria", level: "analista", line: 1, reason: "x", requiredApproverLevel: "analista", amountAtRisk: money(50_000), dockAction: { kind: "receber" }, state: "aguardando_aprovacao", canApprove: true,
  justification: "Faltou mercadoria na doca", items: [], divergences: [], title: { state: "lancado", amount: money(100_000), dueOn: "2026-11-10" }, approval: null,
});

type Reply = { status?: number; body: unknown };

/** #355 O servidor simulado: cada pedido a `/api/ao-vivo` pega a próxima resposta da fila; a última se repete. */
function serve(replies: Reply[]) {
  const live: URL[] = [];
  const proposals: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://web.test");
      if (url.pathname === "/api/ao-vivo") {
        const reply = replies[Math.min(live.length, replies.length - 1)]!;
        live.push(url);
        return Response.json(reply.body, { status: reply.status ?? 200 });
      }
      if (url.pathname.startsWith("/api/propostas/")) {
        const key = decodeURIComponent(url.pathname.split("/")[3]!);
        proposals.push(key);
        return Response.json(proposal(key));
      }
      if (url.pathname.startsWith("/api/supplier-requests/")) return Response.json({ request: null });
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  );
  return { live, proposals };
}

const open = () => {
  window.history.replaceState(null, "", "/pagar/ao-vivo");
  return render(<Frame context={fallbackContext("coordenacao@jachegou.test")} />);
};
const rows = () => Array.from(document.querySelectorAll<HTMLElement>("tbody tr"));
const rowTexts = () => rows().map((tr) => tr.textContent ?? "");
const poll = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("#355 Ao vivo: a tela vista pela rota", () => {
  it("#355/AC-3: abre em /pagar/ao-vivo com o título e os dois números que a API entregou, sem recalcular", async () => {
    const { live } = serve([{ body: FIRST }]);
    open();
    expect(await screen.findByRole("heading", { name: "Ao vivo" })).toBeTruthy();
    expect(await screen.findByText("Resolvidas sem pessoa hoje")).toBeTruthy();
    expect(screen.getByText("74%")).toBeTruthy();
    expect(screen.getByText("Na fila de uma pessoa")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
    // #355 A primeira carga não leva cursor.
    expect(live[0]!.searchParams.get("since")).toBeNull();
  });

  it("#355/AC-1: os passos de todas as notas, do mais novo ao mais velho, cada um com hora, selo e nota", async () => {
    serve([{ body: FIRST }]);
    open();
    await waitFor(() => expect(rows()).toHaveLength(4));
    const [rule, engine, person, run] = rowTexts() as [string, string, string, string];
    expect(rule).toContain("10h21");
    expect(rule).toContain("51234");
    expect(rule).toContain("Regra aprovou");
    expect(engine).toContain("Motor, em sombra, aprovaria");
    expect(person).toContain("10h19");
    expect(person).toContain("51220");
    expect(person).toContain("Decidiu a proposta");
    expect(run).toContain("10h15");
    expect(run).toContain("Rodada: 12 vistas, 4 propostas, 3 pela regra");
    // #355 O título das colunas é o do selo das outras telas.
    expect(screen.getByRole("columnheader", { name: "Decidido por" })).toBeTruthy();
  });

  it("#355/AC-4: o selo de cada linha é o DecidedBy da #211: regra e sistema em ⚙, motor, pessoa pelo nome", async () => {
    serve([{ body: FIRST }]);
    open();
    await waitFor(() => expect(rows()).toHaveLength(4));
    const [rule, engine, person, run] = rows() as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(within(rule).getByText("⚙ Regra")).toBeTruthy();
    expect(within(engine).getByText("Motor")).toBeTruthy();
    expect(within(person).getByText("Ana Souza")).toBeTruthy();
    expect(within(run).getByText("⚙ Automático")).toBeTruthy();
  });

  it("#355/AC-2: o passo gravado depois entra no topo em até 10 s, sem recarregar, e o cursor devolvido vai no pedido seguinte", async () => {
    const { live } = serve([
      { body: FIRST },
      { body: { events: [NEWER], since: SINCE_2, indicators: indicators(75), awaiting: 5 } },
      { body: { events: [], since: SINCE_2, indicators: indicators(75), awaiting: 5 } },
    ]);
    open();
    await waitFor(() => expect(rows()).toHaveLength(4));
    await poll(10_000);
    // #355 O segundo pedido leva o `since` exatamente como a API o devolveu (microssegundos e fuso intactos).
    expect(live.length).toBeGreaterThanOrEqual(2);
    expect(live[1]!.searchParams.get("since")).toBe(SINCE_1);
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(rowTexts()[0]).toContain("51240");
    expect(rowTexts()[0]).toContain("10h23");
    // #355 As que já estavam continuam abaixo, na mesma ordem.
    expect(rowTexts()[1]).toContain("51234");
    // #355 Os números do topo são os do corpo novo.
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    // #355 A página não foi recarregada: o título nunca saiu da tela e a rota é a mesma.
    expect(window.location.pathname).toBe("/pagar/ao-vivo");
    // #355 Sem passo novo: a lista fica como está e o cursor segue o último devolvido.
    await poll(10_000);
    expect(live.length).toBeGreaterThanOrEqual(3);
    expect(live[2]!.searchParams.get("since")).toBe(SINCE_2);
    expect(rows()).toHaveLength(5);
  });

  it("#355/AC-2: se um pedido de atualização falha, a lista fica, o cursor não anda e o próximo pedido refaz o mesmo", async () => {
    const { live } = serve([
      { body: FIRST },
      { status: 502, body: { error: "supabase_indisponivel" } },
      { body: { events: [NEWER], since: SINCE_2, indicators: indicators(75), awaiting: 5 } },
    ]);
    open();
    await waitFor(() => expect(rows()).toHaveLength(4));
    await poll(POLL_MS);
    expect(live.length).toBe(2);
    expect(rows()).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
    await poll(POLL_MS);
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(live[1]!.searchParams.get("since")).toBe(SINCE_1);
    expect(live[2]!.searchParams.get("since")).toBe(SINCE_1);
  });

  it("#355/AC-1: clicar na linha de uma nota abre a gaveta da nota daquela chave; a rodada não tem nota e não abre", async () => {
    const { proposals } = serve([{ body: FIRST }]);
    open();
    await waitFor(() => expect(rows()).toHaveLength(4));
    fireEvent.click(rows()[2]!);
    await waitFor(() => expect(proposals).toEqual([KEY(51220)]));
    expect(await screen.findByText("Faltou mercadoria na doca")).toBeTruthy();
    // #355 A linha da rodada fica fora do Tab e sem rótulo de abrir.
    const run = rows()[3]!;
    expect(run.getAttribute("aria-label")).toBeNull();
    // #355 A rodada é um passo real: o leitor de tela a lê, mesmo fora do Tab.
    expect(run.getAttribute("aria-hidden")).toBeNull();
    expect(run.getAttribute("tabindex")).toBeNull();
    fireEvent.click(run);
    expect(proposals).toEqual([KEY(51220)]);
  });

  it("#355: sem passos, o vazio centralizado diz o que fazer e a tela não mostra tabela", async () => {
    serve([{ body: { events: [], since: null, indicators: indicators(null), awaiting: 0 } }]);
    open();
    const empty = await screen.findByRole("status");
    expect(within(empty).getByText("Nenhum passo da automação ainda")).toBeTruthy();
    expect(within(empty).getByText("Os passos aparecem aqui assim que a automação rodar.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("#355: se a primeira carga falha, a tela diz isso e o Tentar de novo refaz o pedido", async () => {
    const { live } = serve([{ status: 500, body: { error: "falha" } }, { body: FIRST }]);
    open();
    expect(await screen.findByText("Não consegui buscar os passos agora")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(live[1]!.searchParams.get("since")).toBeNull();
  });

  it("#355: enquanto carrega, mostra o estado de carga e nenhuma linha", async () => {
    let release: (() => void) | undefined;
    // #355 Só o pedido do ao vivo fica pendurado; a faixa de automação e o resto não o soltam nem o prendem.
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      if (new URL(String(input), "http://web.test").pathname === "/api/ao-vivo") release = () => resolve(Response.json(FIRST));
      else resolve(Response.json({ error: "not_found" }, { status: 404 }));
    })));
    open();
    expect(await screen.findByText("Buscando os passos da automação…")).toBeTruthy();
    expect(rows()).toHaveLength(0);
    await act(async () => release?.());
    await waitFor(() => expect(rows()).toHaveLength(4));
  });

  it("#355: o Contas a pagar tem o item Ao vivo no menu, e ele leva à tela", async () => {
    serve([{ body: FIRST }]);
    // #355 O menu do shell-kit navega pelo roteador, não por `<a href>`: o item é um controle da barra lateral.
    window.history.replaceState(null, "", "/pagar/hoje");
    render(<Frame context={fallbackContext("coordenacao@jachegou.test")} />);
    const item = await within(document.querySelector("aside")!).findByText("Ao vivo");
    fireEvent.click(item);
    expect(await screen.findByRole("heading", { name: "Ao vivo" })).toBeTruthy();
    expect(window.location.pathname).toBe("/pagar/ao-vivo");
    await waitFor(() => expect(rows()).toHaveLength(4));
  });
});

describe("#355 Ao vivo: acessibilidade da página montada", () => {
  it("um só marco principal e um só título; a tabela tem colunas com nome e as linhas de nota entram no Tab com o rótulo", async () => {
    serve([{ body: FIRST }]);
    open();
    await waitFor(() => expect(rows()).toHaveLength(4));
    // #355 O `RowTable` põe o rótulo e o Tab depois que o `Table` desenha as linhas.
    await waitFor(() => expect(rows()[0]!.getAttribute("aria-label")).toBe("Abrir a nota 51234"));
    const main = screen.getByRole("main");
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(within(main).getAllByRole("heading", { name: "Ao vivo" })).toHaveLength(1);
    const headers = within(main).getAllByRole("columnheader");
    expect(headers.length).toBeGreaterThanOrEqual(4);
    headers.forEach((th) => expect((th.textContent ?? "").length).toBeGreaterThan(0));
    expect(within(main).getAllByRole("row", { name: /^Abrir a nota 51234$/ })).toHaveLength(2);
    expect(within(main).getAllByRole("row", { name: "Abrir a nota 51220" })).toHaveLength(1);
    expect(document.querySelectorAll("[tabindex]:not([tabindex='0']):not([tabindex='-1'])")).toHaveLength(0);
  });
});
