import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import type { ReadingRowDto, SentRequestDetailDto } from "../src/api/contract";
import { fallbackContext } from "../src/shell/context";
import { texts } from "../src/texts";

/**
 * #157 A checagem de acessibilidade da página montada, "Pedidos ao fornecedor" (#157), na camada de contrato (testing-frontend, passo 5).
 * #157 Não há axe em web/ e nenhuma dependência entra (#155): a consulta por papel e nome acessível faz o papel dele sobre a página inteira,
 * #157 com a moldura, a lista e a gaveta abertas juntas. O que só a composição revela: nomes repetidos entre regiões, controle sem nome, título fora de ordem.
 */

const KEY = "0".repeat(43) + "1";

const ROW: ReadingRowDto = {
  id: 1,
  invoiceAccessKey: KEY,
  invoiceNumber: "59738",
  supplierId: "F07",
  supplierName: "Limpeza",
  requestType: "return_note",
  totalCents: 26362,
  dueOn: "2026-11-14",
  status: "sent",
  reading: null,
  followUp: { drafted: true, sent: false },
};

const DETAIL: SentRequestDetailDto = {
  status: "sent",
  invoiceAccessKey: KEY,
  requestType: "return_note",
  returnNote: { number: "ND-6", supplier: "F07", reference: "59738", lines: [], total: { text: "R$ 263,62" } },
  email: { to: "financeiro@f07-limpeza.example", dueOn: "2026-11-14", subject: "Devolução", body: "Segue.", template: "Segue." },
  asks: [],
  sentBy: "analista@barte.com",
  sentAt: "2026-11-07T12:40:00.000Z",
  reading: null,
  documentConfirmation: null,
  followUp: {
    drafted: true,
    sent: false,
    draft: { subject: "Cobrança da NF 59738", body: "Olá, não recebemos retorno.", template: "Olá, não recebemos retorno.", asks: [] },
    sentBy: null,
    sentAt: null,
    failure: null,
    dueOn: "2026-11-19",
  },
};

const respond = async (input: RequestInfo | URL): Promise<Response> => {
  const path = String(input);
  if (path.startsWith("/api/propostas/")) return Response.json({ error: "not_found" }, { status: 404 });
  if (path.startsWith("/api/supplier-requests?status=")) {
    const filter = path.slice("/api/supplier-requests?status=".length);
    return Response.json({ filter, requests: filter === "overdue" ? [ROW] : [], counts: { awaiting: 0, answered: 0, needs_you: 0, overdue: 1 } });
  }
  if (path === `/api/supplier-requests/${KEY}`) return Response.json({ request: DETAIL });
  return Response.json({ error: "not_found" }, { status: 404 });
};

/** #157 O nome de uma região: o `aria-label`, ou o texto do que a rotula (`aria-labelledby`). */
function regionName(region: HTMLElement): string {
  const label = region.getAttribute("aria-label");
  if (label) return label;
  const ids = (region.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
}

async function openDrawerOnLateRow(): Promise<void> {
  window.history.replaceState(null, "", "/pedidos-fornecedor"); // ADR-004
  render(<Frame context={fallbackContext("analista@barte.com")} />);
  fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
  const row = (await screen.findByText("NF 59738")).closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: "Cobrar" }));
  await screen.findByText("Rascunho da cobrança");
}

describe("#157: acessibilidade da página /pedidos-fornecedor montada", () => { // ADR-004
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(respond)));
  afterEach(() => vi.unstubAllGlobals());

  it("#157: a página tem a navegação do menu, um só título da tela e a grid com as seis colunas nomeadas", async () => {
    await openDrawerOnLateRow();
    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: texts.supplierRequests.title })).toHaveLength(1);
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Nota", "Fornecedor", "Solicitação", "Valor", "Prazo", "Status"]);
    // #157 A linha inteira abre a gaveta: ela tem nome para leitor de tela e entra na ordem do Tab.
    const row = screen.getByText("NF 59738").closest("tr")!;
    expect(row.getAttribute("aria-label")).toBe("Nota 59738, F07 Limpeza");
    expect(row.getAttribute("tabindex")).toBe("0");
  });

  it("#157: todo botão, chip (radio) e link da página, com a gaveta aberta, tem nome acessível", async () => {
    await openDrawerOnLateRow();
    // #157 A trilha (Breadcrumb) é da moldura do shell-kit, não desta página: a casa dela sai sem nome
    // pelo design system, e o ajuste é do kit, não do pedido ao fornecedor.
    const fromPage = (el: HTMLElement) => !el.closest('nav[aria-label="Breadcrumb"]');
    for (const role of ["button", "radio", "link"] as const) {
      const all = screen.queryAllByRole(role).filter(fromPage);
      // #157 O menu é da moldura: só os botões e os chips são daqui, então só eles têm de existir; o link, se houver, também tem nome.
      if (role !== "link") expect(all.length, `há ${role} na página`).toBeGreaterThan(0);
      // #157 O filtro por nome usa o nome acessível calculado: o controle sem nome fica de fora e a conta não fecha.
      expect(screen.queryAllByRole(role, { name: /\S/ }).filter(fromPage), `todo ${role} tem nome`).toHaveLength(all.length);
    }
    // #207 O chip mantém a contagem no texto ("Aguardando · 2", GridFilter.test.tsx); o nome é o que vem antes dela.
    expect(screen.getAllByRole("radio").map((chip) => chip.textContent?.replace(/\s*·\s*\d+$/, ""))).toEqual(["Aguardando", "Atendidos", "Precisam de você", "Atrasados"]);
  });

  it("#157: os nomes das regiões são únicos, e a conversa desta tela não repete o nome do bloco da #156", async () => {
    await openDrawerOnLateRow();
    const names = screen.getAllByRole("region").map(regionName);
    expect(names.every((name) => name !== "")).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(texts.supplierRequests.conversation.regionLabel);
    expect(names).toContain(texts.supplierRequests.draft.title);
    expect(names).not.toContain(texts.supplierRequest.title);
  });

  it("#157: dentro da gaveta, os títulos descem um nível por vez, sem saltos", async () => {
    await openDrawerOnLateRow();
    const region = screen.getByRole("region", { name: texts.supplierRequests.conversation.regionLabel });
    const levels = within(region)
      .getAllByRole("heading")
      .map((heading) => Number(heading.tagName.slice(1)));
    expect(levels[0]).toBe(3);
    levels.slice(1).forEach((level, index) => expect(level - levels[index]!).toBeLessThanOrEqual(1));
    expect(within(region).getByRole("heading", { name: "Pedido enviado" })).toBeTruthy();
    expect(within(region).getByRole("heading", { name: "Resposta do fornecedor" })).toBeTruthy();
    expect(within(region).getByRole("heading", { name: "Leitura do agente" })).toBeTruthy();
  });
});
