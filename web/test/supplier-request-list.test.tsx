import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import type { DocumentConfirmationDto, ReadingRowDto, ReplyFilterDto, SentRequestDetailDto } from "../src/api/contract";
import { fallbackContext, NAVIGATION } from "../src/shell/context";

/**
 * #157 Esqueleto de ponta a ponta da lista "Pedidos ao fornecedor" (história #157), escrito contra o
 * wireframe aprovado em artifacts/wireframe-pedidos-fornecedor/index.html.
 *
 * #157 Ele nasceu vermelho de propósito, em `describe.skip` com `it.fails` (#157): as dependências do web não instalam (#155).
 * #157 Agora a rota, a lista e a gaveta estão ligadas ao contrato (api/src/http/supplier-requests.ts, #157), e cada comportamento é um `it`.
 *
 * #157 A API é falsa e fala o contrato de verdade: `GET /api/supplier-requests?status=` devolve `{ filter, requests, counts }` com as
 * #157 contagens dos quatro filtros, `GET /api/supplier-requests/{chave}` devolve o pedido enviado com a leitura e o rascunho da
 * #157 cobrança, e `POST .../send` envia a cobrança. A tela não conta nem filtra por conta própria: o que ela mostra é o que o servidor disse.
 */

/** #157 Um pedido da API falsa e o filtro em que o servidor o põe. */
interface Fixture {
  row: ReadingRowDto;
  filter: ReplyFilterDto;
}

const keyOf = (id: number): string => String(id).padStart(44, "0");

const fixture = (id: number, invoiceNumber: string, supplierId: string, supplierName: string, totalCents: number, dueOn: string, filter: ReplyFilterDto): Fixture => ({
  row: {
    id,
    invoiceAccessKey: keyOf(id),
    invoiceNumber,
    supplierId,
    supplierName,
    requestType: "return_note",
    totalCents,
    dueOn,
    status: "sent",
    reading: null,
    followUp: { drafted: filter === "overdue", sent: false },
  },
  filter,
});

/** #157 O cenário "cobrar um atrasado": dois pedidos atrasados e um aguardando (filtro inicial). Dados fictícios. */
const SUPPLIER_REQUESTS: Fixture[] = [
  fixture(1, "59738", "F07", "Limpeza", 26362, "2026-11-14", "overdue"),
  fixture(2, "40519", "F09", "Embalagens", 154090, "2026-11-12", "overdue"),
  fixture(3, "51877", "F02", "Bebidas", 98000, "2026-11-20", "awaiting"),
];

/** #157 O cenário "confirmar documento": o pedido que atendeu e cita NF-D 881 espera a pessoa em "Precisam de você". */
const TO_CONFIRM: Fixture = (() => {
  const base = fixture(4, "61004", "F07", "Limpeza", 216320, "2026-11-18", "needs_you");
  const reading = { replyOutcome: "fulfilled", fulfilledAsks: ["devolução dos 3 itens"], supplierDocument: "NF-D 881", summary: "O fornecedor diz que emitiu a NF-D 881.", nextStep: "confirm_document", injectionFlag: null } as const;
  return { ...base, row: { ...base.row, reading: { ...reading, fulfilledAsks: [...reading.fulfilledAsks] } } };
})();

/** #157 O pedido enviado que o `GET /api/supplier-requests/{chave}` devolve: sem leitura (atrasado) e com o rascunho da cobrança. */
function sentView(row: ReadingRowDto, documentConfirmation: DocumentConfirmationDto | null = null): SentRequestDetailDto {
  return {
    status: "sent",
    invoiceAccessKey: row.invoiceAccessKey,
    requestType: "return_note",
    returnNote: { number: "ND-6", supplier: row.supplierId, reference: row.invoiceNumber, lines: [], total: { text: "R$ 263,62" } },
    email: { to: "financeiro@f07-limpeza.example", dueOn: row.dueOn, subject: "Devolução", body: "Segue a devolução.", template: "Segue a devolução." },
    asks: [],
    sentBy: "analista@barte.com",
    sentAt: "2026-11-07T12:40:00.000Z",
    reading: row.reading,
    documentConfirmation,
    followUp: {
      drafted: true,
      sent: row.followUp.sent,
      draft: {
        subject: `Cobrança: nota de devolução da NF ${row.invoiceNumber}`,
        body: "Olá, não recebemos retorno. Pode nos responder até 20/11?",
        template: "Olá, não recebemos retorno. Pode nos responder até {{cobranca.prazo}}?",
        asks: [],
      },
      sentBy: row.followUp.sent ? "analista@barte.com" : null,
      sentAt: row.followUp.sent ? "2026-11-16T13:12:00.000Z" : null,
      failure: null,
      dueOn: "2026-11-19",
    },
  };
}

describe("#157: /pedidos-fornecedor (wireframe aprovado, #157)", () => { // ADR-004
  // #157 A API falsa: o servidor decide o filtro e as contagens; a proposta da gaveta é 404 (a gaveta da nota mostra só o bloco desta tela).
  let requests: Fixture[] = SUPPLIER_REQUESTS;
  let failList = false;
  let failDetail = false;
  /** #157 O texto que a API falsa guarda (o molde com {{chave}}); o PATCH o troca, e o POST .../send envia o que está aqui. */
  let savedTemplate: string | null = null;
  /** #157 O que a API falsa gravou na confirmação, por chave de acesso; o POST .../confirm-document move o pedido de "needs_you" para "answered". */
  let confirmations: Record<string, DocumentConfirmationDto> = {};
  let failConfirm = false;
  let calls: { method: string; path: string; body?: unknown }[] = [];
  const counts = () => ({
    awaiting: requests.filter((r) => r.filter === "awaiting").length,
    answered: requests.filter((r) => r.filter === "answered").length,
    needs_you: requests.filter((r) => r.filter === "needs_you").length,
    overdue: requests.filter((r) => r.filter === "overdue").length,
  });
  const respond = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = String(input);
    calls.push({ method: init.method ?? "GET", path, ...(init.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (path.startsWith("/api/propostas/")) return Response.json({ error: "not_found" }, { status: 404 });
    if (path.startsWith("/api/supplier-requests?status=")) {
      if (failList) throw new TypeError("network");
      const filter = path.slice("/api/supplier-requests?status=".length) as ReplyFilterDto;
      return Response.json({ filter, requests: requests.filter((r) => r.filter === filter).map((r) => r.row), counts: counts() });
    }
    if (path.startsWith("/api/supplier-requests/")) {
      const key = path.slice("/api/supplier-requests/".length).replace("/send", "").replace("/follow-up", "").replace("/confirm-document", "");
      if (failDetail) return Response.json({ error: "internal_error", detail: "SQLSTATE 42P01 relation supplier_requests" }, { status: 500 });
      const found = requests.find((r) => r.row.invoiceAccessKey === key);
      if (!found) return Response.json({ error: "not_found" }, { status: 404 });
      const view = sentView(found.row, confirmations[key] ?? null);
      if (path.endsWith("/confirm-document") && init.method === "POST") {
        if (failConfirm) return Response.json({ error: "supabase_unavailable", correlationId: "c-64", detail: "SQLSTATE 42P01 supplier_requests" }, { status: 502 });
        if (confirmations[key]) return Response.json({ error: "conflict", reason: "already_confirmed" }, { status: 409 });
        const done = { document: found.row.reading?.supplierDocument ?? "", by: "analista@barte.com", at: "2026-11-17T13:05:00.000Z" };
        confirmations = { ...confirmations, [key]: done };
        requests = requests.map((r) => (r === found ? { ...r, filter: "answered" } : r));
        return Response.json({ request: sentView(found.row, done) });
      }
      if (savedTemplate !== null && view.followUp.draft) view.followUp.draft = { ...view.followUp.draft, template: savedTemplate, body: savedTemplate.replace("{{cobranca.prazo}}", "20/11") };
      if (path.endsWith("/follow-up") && init.method === "PATCH") {
        const { template } = JSON.parse(String(init.body)) as { template: string };
        // #157 O servidor recusa o texto sem marcador (número solto) com um 422 que traz texto interno, que a tela não pode mostrar.
        if (!template.includes("{{")) return Response.json({ error: "invalid", reason: "number_mismatch", field: "body", detail: "SQLSTATE 42P01 catalogo" }, { status: 422 });
        savedTemplate = template;
        return Response.json({ request: { ...view, followUp: { ...view.followUp, draft: { ...view.followUp.draft!, template, body: template.replace("{{cobranca.prazo}}", "20/11") } } } });
      }
      if (path.endsWith("/send")) {
        return Response.json({ request: { ...view, followUp: { ...view.followUp, sent: true, sentBy: "analista@barte.com", sentAt: "2026-11-16T13:12:00.000Z" } } });
      }
      return Response.json({ request: view });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  beforeEach(() => {
    requests = SUPPLIER_REQUESTS;
    failList = false;
    failDetail = false;
    savedTemplate = null;
    confirmations = {};
    failConfirm = false;
    calls = [];
    vi.stubGlobal("fetch", vi.fn(respond));
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderRoute() {
    window.history.replaceState(null, "", "/pedidos-fornecedor"); // ADR-004
    return render(<Frame context={fallbackContext("analista@barte.com")} />);
  }

  it("#157: o menu 'Contas a pagar' tem 'Pedidos ao fornecedor' depois dos itens existentes", () => {
    const group = NAVIGATION.find((g) => g.key === "pagar")!;
    const last = group.items[group.items.length - 1]!;
    expect(last.label).toBe("Pedidos ao fornecedor");
    expect(last.href).toBe("/pedidos-fornecedor"); // ADR-004
    expect(group.items.map((i) => i.label).slice(0, 4)).toEqual([
      "Fila de aprovação",
      "Lista do dia",
      "Notas duplicadas",
      "Pagamento errado evitado",
    ]);
  });

  it("#157: a rota abre com o título, os chips com contagem e o chip Aguardando ativo", async () => {
    renderRoute();
    expect(await screen.findByRole("heading", { name: "Pedidos ao fornecedor" })).toBeTruthy();
    // #157 As contagens e a linha só vêm com a lista pronta: a espera é pela linha aguardando.
    expect(await screen.findByText("NF 51877")).toBeTruthy();
    // #157 Os chips são radios do filtro de situação (como em devolucoes.test.tsx), não texto solto.
    // #157 A célula de Status "Aguardando" da linha também casaria com getByText.
    const waitingChip = await screen.findByRole("radio", { name: /^Aguardando/ });
    for (const chip of [/^Atendidos/, /^Precisam de você/, /^Atrasados/]) {
      expect(screen.getByRole("radio", { name: chip })).toBeTruthy();
    }
    expect(screen.getByRole("radio", { name: /^Atrasados/ }).textContent).toMatch(/2/);
    // #157 Q3 (wireframe): o filtro inicial é Aguardando. Só a linha aguardando aparece.
    expect(waitingChip.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("NF 59738")).toBeNull();
    // #157 Só o filtro Aguardando foi pedido ao servidor, que também trouxe as contagens dos outros três.
    expect(calls.filter((c) => c.path.startsWith("/api/supplier-requests?")).map((c) => c.path)).toEqual(["/api/supplier-requests?status=awaiting"]);
  });

  it("#157: cenário: filtrar 'Atrasados' mostra os dois com Nota, Fornecedor, Solicitação, Valor, Prazo e Status, por prazo crescente", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    // #157 O chip pede o filtro ao servidor: a grid some enquanto carrega e volta com as linhas do filtro.
    await screen.findByText("NF 40519");

    for (const header of ["Nota", "Fornecedor", "Solicitação", "Valor", "Prazo", "Status"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    // #157 Prazo crescente: o mais atrasado primeiro.
    const first = within(rows[0]!);
    expect(first.getByText("NF 40519")).toBeTruthy();
    expect(first.getByText("F09 Embalagens")).toBeTruthy();
    expect(first.getByText("Nota de devolução")).toBeTruthy();
    expect(first.getByText(/R\$\s*1\.540,90/)).toBeTruthy();
    expect(first.getByText("12/11")).toBeTruthy();
    expect(first.getByText(/Atrasado/)).toBeTruthy();
    const second = within(rows[1]!);
    expect(second.getByText("NF 59738")).toBeTruthy();
    expect(second.getByText("F07 Limpeza")).toBeTruthy();
    expect(second.getByText(/R\$\s*263,62/)).toBeTruthy();
    expect(second.getByText("14/11")).toBeTruthy();
    expect(second.getByRole("button", { name: "Cobrar" })).toBeTruthy();
  });

  it("#157: clicar na linha abre a gaveta no bloco 'Pedido ao fornecedor' com a conversa e a leitura do agente", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("NF 59738")).closest("tr")!;
    fireEvent.click(row);

    // #157 A gaveta do barte-design-system mostra o título como texto dentro de role="dialog": acha-se pelo nome do diálogo, não por um heading (#155).
    expect(await screen.findByRole("dialog", { name: /Proposta da NF/ })).toBeTruthy();
    // #157 Dentro da região desta tela: a gaveta da nota (#156) também escreve "Pedido ao fornecedor".
    const region = await screen.findByRole("region", { name: "Conversa e leitura do pedido" });
    expect(within(region).getAllByText("Pedido ao fornecedor")).toHaveLength(1);
    // #157 Estado 7 do wireframe: pedido enviado, resposta do fornecedor e leitura do agente.
    expect(screen.getByText(/Pedido enviado/)).toBeTruthy();
    expect(screen.getByText(/Resposta do fornecedor/)).toBeTruthy();
    expect(screen.getByText(/Leitura do agente/)).toBeTruthy();
  });

  it("#157: cenário: 'Cobrar' abre a gaveta no bloco 'Pedido ao fornecedor' com o rascunho da cobrança, sem enviar", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("NF 59738")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Cobrar" }));

    // #155 A gaveta se acha pelo nome do diálogo (o título é texto dentro de role="dialog", não um heading).
    expect(await screen.findByRole("dialog", { name: /Proposta da NF/ })).toBeTruthy();
    // #157 O pedido da gaveta vem do servidor, depois do título: o bloco e o rascunho esperam por ele.
    const region = await screen.findByRole("region", { name: "Conversa e leitura do pedido" });
    expect(within(region).getAllByText("Pedido ao fornecedor")).toHaveLength(1);
    expect(await screen.findByText("Rascunho da cobrança")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enviar cobrança" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Descartar rascunho" })).toBeTruthy();
    // #157 A cobrança só sai no clique em enviar: nenhum POST até lá.
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("#157: 'Enviar cobrança' faz um POST em .../send, sem texto, e a linha cobrada segue em Atrasados como 'Atrasado (cobrado)', sem 'Cobrar', com as contagens do servidor (#157)", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("NF 59738")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Cobrar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Enviar cobrança" }));

    expect(await screen.findByText(/Cobrança enviada por você/)).toBeTruthy();
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toEqual([{ method: "POST", path: `/api/supplier-requests/${keyOf(1)}/send`, body: {} }]);
    const charged = (await screen.findByText("NF 59738")).closest("tr")!;
    expect(within(charged).getByText("Atrasado (cobrado)")).toBeTruthy();
    expect(within(charged).queryByRole("button", { name: "Cobrar" })).toBeNull();
    expect(screen.getByRole("radio", { name: /^Atrasados/ }).textContent).toMatch(/2/);
    expect(screen.getByRole("radio", { name: /^Aguardando/ }).textContent).toMatch(/1/);
  });

  it("#157: cenário: Cobrar e Editar abre o texto com os marcadores {{...}} e a dica; salvar faz o PATCH e enviar manda a cobrança com o texto editado", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("NF 59738")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Cobrar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));

    const field = screen.getByRole("textbox", { name: "Texto" }) as HTMLTextAreaElement;
    expect(field.value).toBe("Olá, não recebemos retorno. Pode nos responder até {{cobranca.prazo}}?");
    expect(screen.getByText(/Mantenha os marcadores \{\{\.\.\.\}\}/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Enviar cobrança" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(field, { target: { value: "Pode responder até {{cobranca.prazo}}, por favor?" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar texto" }));
    expect(await screen.findByText("Pode responder até 20/11, por favor?")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Texto" })).toBeNull();
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([
      { method: "PATCH", path: `/api/supplier-requests/${keyOf(1)}/follow-up`, body: { template: "Pode responder até {{cobranca.prazo}}, por favor?" } },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Enviar cobrança" }));
    expect(await screen.findByText(/Cobrança enviada por você/)).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST")).toEqual([{ method: "POST", path: `/api/supplier-requests/${keyOf(1)}/send`, body: {} }]);
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
  });

  it("#157: o 422 do PATCH mantém a edição aberta com a mensagem fixa, sem o texto do servidor, e o Enviar segue desligado", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("NF 59738")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Cobrar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Texto" }), { target: { value: "Pague 263,62 já" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar texto" }));

    const alert = await screen.findByText(/O texto não foi salvo: confira os marcadores/);
    expect(alert).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Texto" }) as HTMLTextAreaElement).value).toBe("Pague 263,62 já");
    expect((screen.getByRole("button", { name: "Enviar cobrança" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toMatch(/SQLSTATE|catalogo|number_mismatch|invalid_shape/);
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("#157: a linha que o servidor já cobrou (followUp.sent) segue em Atrasados como 'Atrasado (cobrado)', sem 'Cobrar', e a gaveta não oferece cobrar de novo", async () => {
    requests = [{ ...SUPPLIER_REQUESTS[0]!, row: { ...SUPPLIER_REQUESTS[0]!.row, followUp: { drafted: true, sent: true } } }];
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("NF 59738")).closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Cobrar" })).toBeNull();
    expect(within(row).getByText("Atrasado (cobrado)")).toBeTruthy();
    fireEvent.click(row);
    const region = await screen.findByRole("region", { name: "Conversa e leitura do pedido" });
    expect(within(region).queryByRole("button", { name: /Cobrar/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enviar cobrança" })).toBeNull();
  });

  it("#157 #157: cenário: o pedido 'Atendeu, falta confirmar: NF-D 881' mostra 'Confirmar documento'; o clique faz um POST em .../confirm-document, mostra 'Documento NF-D 881 confirmado por você', o pedido passa para Atendidos e as contagens se atualizam", async () => {
    requests = [...SUPPLIER_REQUESTS, TO_CONFIRM];
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Precisam de você/ }));
    const row = (await screen.findByText("NF 61004")).closest("tr")!;
    expect(within(row).getByText("Atendeu: NF-D 881")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Precisam de você/ }).textContent).toMatch(/1/);
    fireEvent.click(row);

    const button = await screen.findByRole("button", { name: "Confirmar documento NF-D 881" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByText(/^Documento NF-D 881 confirmado por você/)).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST")).toEqual([{ method: "POST", path: `/api/supplier-requests/${keyOf(4)}/confirm-document`, body: {} }]);
    expect(screen.queryByRole("button", { name: /Confirmar documento/ })).toBeNull();
    // #157 A lista é relida: o pedido sai de "Precisam de você" e entra em "Atendidos", com as contagens do servidor.
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Precisam de você/ }).textContent).toMatch(/0/));
    expect(screen.getByRole("radio", { name: /^Atendidos/ }).textContent).toMatch(/1/);
    expect(screen.queryByText("NF 61004")).toBeNull();
    // #157 A gaveta segue aberta no pedido confirmado, com a linha de quem e quando.
    expect(screen.getByRole("region", { name: "Conversa e leitura do pedido" })).toBeTruthy();
    expect(screen.getByText(/confirmado por você em 17\/11 às 10:05/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /^Atendidos/ }));
    expect(await screen.findByText("NF 61004")).toBeTruthy();
  });

  it("#157: a confirmação que falha (502) mostra a mensagem fixa, nunca o corpo da resposta, mantém o botão e o pedido em 'Precisam de você', e tentar de novo confirma", async () => {
    requests = [...SUPPLIER_REQUESTS, TO_CONFIRM];
    failConfirm = true;
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Precisam de você/ }));
    fireEvent.click((await screen.findByText("NF 61004")).closest("tr")!);
    fireEvent.click(await screen.findByRole("button", { name: "Confirmar documento NF-D 881" }));

    expect(await screen.findByText("Não consegui falar com o servidor agora. O documento não foi confirmado.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SQLSTATE|supplier_requests|supabase_unavailable|c-64/);
    expect(screen.getByRole("radio", { name: /^Precisam de você/ }).textContent).toMatch(/1/);
    expect(screen.queryByText(/confirmado por/)).toBeNull();

    failConfirm = false;
    fireEvent.click(screen.getByRole("button", { name: "Confirmar documento NF-D 881" }));
    expect(await screen.findByText(/^Documento NF-D 881 confirmado por você/)).toBeTruthy();
  });

  it("#157: o pedido sem documento a confirmar (atrasado, com a leitura de cobrar) não mostra 'Confirmar documento' na gaveta", async () => {
    requests = [...SUPPLIER_REQUESTS, TO_CONFIRM];
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    fireEvent.click((await screen.findByText("NF 59738")).closest("tr")!);
    await screen.findByRole("region", { name: "Conversa e leitura do pedido" });
    expect(screen.queryByRole("button", { name: /Confirmar documento/ })).toBeNull();
  });

  it("#157: a leitura da gaveta que falha mostra a mensagem fechada, nunca o corpo da resposta da API", async () => {
    failDetail = true;
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("NF 59738")).closest("tr")!;
    fireEvent.click(row);

    expect(await screen.findByText("Não consegui carregar o pedido ao fornecedor.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SQLSTATE|supplier_requests|internal_error/);
  });

  // #157 Estados desenhados no wireframe: erro, vazio e chip com contagem 0.
  it("#157: estado de erro: a lista falha, mostra 'Tentar de novo' e, ao tentar, volta a carregar a lista", async () => {
    failList = true;
    renderRoute();
    expect(await screen.findByText("Não consegui carregar os pedidos ao fornecedor.")).toBeTruthy();
    failList = false;
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("NF 51877")).toBeTruthy();
  });

  it("#157: estado vazio: sem solicitações, diz o que fazer e oferece ir à Fila de aprovação", async () => {
    requests = [];
    renderRoute();
    expect(await screen.findByText("Nenhum pedido ao fornecedor ainda.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ir para a Fila de aprovação" })).toBeTruthy();
  });

  it("#157: chip com contagem 0: 'Atrasados 0' mostra 'Nenhum pedido atrasado' e a ação 'Ver todos'", async () => {
    requests = SUPPLIER_REQUESTS.filter((r) => r.filter === "awaiting");
    renderRoute();
    const lateChip = await screen.findByRole("radio", { name: /^Atrasados/ });
    expect(lateChip.textContent).toMatch(/0/);
    fireEvent.click(lateChip);
    expect(await screen.findByText(/Nenhum pedido atrasado/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ver todos" })).toBeTruthy();
  });
});
