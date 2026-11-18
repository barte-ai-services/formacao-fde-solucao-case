import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { fallbackContext } from "../src/shell/context";
import { texts } from "../src/texts";

// #156 O bloco "Pedido ao fornecedor" na gaveta da proposta decidida, como no wireframe
// artifacts/wireframe-pedido-ao-fornecedor/index.html. Esqueleto de ponta a ponta (#156), vermelho até a #156:
// #156 agora a gaveta inteira roda contra a API falsa, nos caminhos e na forma que api/src/http/supplier-requests.ts
// #156 fixa (rotas pela chave de acesso da nota, PATCH com `template`, anexo em return-note.json, `failure` em código).

const KEY = "35261100000000000000550010000200461000200461";
const BASE = `/api/supplier-requests/${KEY}`;
const t = texts.supplierRequest;
const money = (cents: number) => ({ cents, text: `R$ ${(cents / 100).toFixed(2).replace(".", ",")}` });
const reais = (text: string) => ({ text });

const MAIL_TEXT = "Na NF 20046 veio Shampoo 350 ml no lugar do Creme dental 90 g pedido.";
const TEMPLATE = "Na NF {{nota_numero}} veio {{item_quantidade}} no lugar do pedido.";
const draft = {
  status: "draft",
  invoiceAccessKey: KEY,
  requestType: "return_note",
  returnNote: {
    number: null,
    supplier: "F11",
    reference: "20046",
    lines: [
      { description: "Shampoo 350 ml", quantity: "40 UN", unitPrice: reais("R$ 54,08"), total: reais("R$ 2163,20") },
      { description: "Condicionador 350 ml", quantity: "10 UN", unitPrice: reais("R$ 30,00"), total: reais("R$ 300,00") },
    ],
    total: reais("R$ 2463,20"),
  },
  email: { to: "fiscal@higienetotal.test", dueOn: "2026-11-18", subject: "NF 20046 · devolução do item trocado", body: MAIL_TEXT, template: TEMPLATE },
  asks: ["Confirmar o recebimento da devolução."],
};
const issued = {
  ...draft,
  returnNote: { ...draft.returnNote, number: "ND-0012" },
  attachment: { name: "ND-0012.json", url: `${BASE}/return-note.json` },
};
const sent = { ...issued, status: "sent", sentBy: "ana@jachegou.test", sentAt: "2026-11-15T13:40:00Z" };
const sendFailed = { ...issued, status: "send_failed", failure: "resend_unavailable" };

const detail = {
  invoiceAccessKey: KEY,
  number: "20046",
  supplierId: "F11",
  store: "LJ-001",
  issuedOn: "2026-11-10",
  total: money(216_320),
  classification: "E2",
  exceptionCode: "E2",
  exceptionName: "Item trocado",
  level: "analista",
  line: 1,
  reason: "Item trocado (E2)",
  requiredApproverLevel: "analista",
  amountAtRisk: money(216_320),
  dockAction: { kind: "receber_parcial" },
  state: "decidida",
  canApprove: true,
  justification: "Item trocado",
  items: [],
  divergences: [],
  title: { state: "em_espera", amount: money(216_320), dueOn: "2026-11-18" },
  approval: { approver: "ana@jachegou.test", approverLevel: "analista", dockAction: { kind: "receber_parcial" }, justification: "x", decidedOn: "2026-11-15" },
};

let current: unknown;
let readStatus = 200;
let calls: { method: string; path: string; body: unknown }[] = [];
let onWrite: (method: string, path: string) => Response;

beforeEach(() => {
  calls = [];
  readStatus = 200;
  onWrite = () => Response.json({ request: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = String(input);
      calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (method !== "GET") return onWrite(method, path);
      if (path === BASE) return readStatus === 200 ? Response.json({ request: current }) : Response.json({ error: "internal_error" }, { status: readStatus });
      return Response.json(detail);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openDrawer() {
  window.history.replaceState(null, "", `/pagar/fila/${KEY}`); // ADR-004
  render(<Frame context={fallbackContext("ana@jachegou.test")} />);
  await screen.findByText("Decisão registrada");
}
const region = () => screen.getByRole("region", { name: "Pedido ao fornecedor" });
const sentTo = (method: string, suffix: string) => calls.some((c) => c.method === method && c.path === `${BASE}${suffix}`);
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("#156 bloco Pedido ao fornecedor na gaveta, de ponta a ponta (#156)", () => {
  it("#156: a proposta decidida com pedido mostra o bloco com o selo do Claude, abaixo da decisão", async () => {
    current = draft;
    await openDrawer();
    const block = await screen.findByRole("region", { name: "Pedido ao fornecedor" });
    expect(within(block).getByText("Claude")).toBeTruthy();
    expect(screen.getByText("Decisão registrada").compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(calls.some((c) => c.method === "GET" && c.path === BASE)).toBe(true);
  });

  it("#156: sem pedido, o bloco não existe, nem o título", async () => {
    current = null;
    await openDrawer();
    await waitFor(() => expect(calls.some((c) => c.path === BASE)).toBe(true));
    expect(screen.queryByRole("region", { name: "Pedido ao fornecedor" })).toBeNull();
    expect(screen.queryByText("Pedido ao fornecedor")).toBeNull();
  });

  it("#156: escrevendo mostra que o Claude está preparando, sem botões do pedido", async () => {
    current = { status: "writing" };
    await openDrawer();
    expect(await screen.findByText(t.writing)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Emitir e enviar" })).toBeNull();
  });

  it("#156: o rascunho mostra a nota (itens, valores, total) e o e-mail (para, prazo, assunto, texto), ainda sem anexo", async () => {
    current = draft;
    await openDrawer();
    const inBlock = within(await screen.findByRole("region", { name: "Pedido ao fornecedor" }));
    expect(inBlock.getAllByText(/Shampoo 350 ml/).length).toBeGreaterThan(0);
    expect(inBlock.getByText(/Condicionador 350 ml/)).toBeTruthy();
    expect(inBlock.getByText(/40 UN/)).toBeTruthy();
    expect(inBlock.getByText(/R\$ 54,08/)).toBeTruthy();
    expect(inBlock.getByText(/R\$ 2163,20/)).toBeTruthy(); // #156 total da linha 1
    expect(inBlock.getByText(/R\$ 300,00/)).toBeTruthy(); // #156 total da linha 2
    expect(inBlock.getByText(/R\$ 2463,20/)).toBeTruthy(); // #156 total da nota, diferente de cada linha
    expect(inBlock.getByText(/Para: F11 · Ref\.: 20046/)).toBeTruthy();
    expect(inBlock.getByText(/fiscal@higienetotal\.test/)).toBeTruthy();
    expect(inBlock.getByText(/Prazo: 18\/11/)).toBeTruthy();
    expect(inBlock.getByText(/NF 20046 · devolução do item trocado/)).toBeTruthy();
    expect(inBlock.getByText(MAIL_TEXT, { exact: false })).toBeTruthy();
    expect(inBlock.queryByText(/\{\{/)).toBeNull(); // #156 o corpo desenhado é o renderizado, nunca o molde
    expect(inBlock.queryByRole("link")).toBeNull(); // #156 o anexo só existe depois da emissão
    expect(inBlock.getByRole("button", { name: "Emitir e enviar" })).toBeTruthy();
  });

  it("#156: Emitir e enviar chama POST /send, sem confirmação, e mostra emitida e enviada com o anexo", async () => {
    current = draft;
    onWrite = () => {
      current = sent;
      return Response.json({ request: sent });
    };
    await openDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Emitir e enviar" }));
    expect(await screen.findByText(/Nota de devolução ND-0012 emitida e enviada por você às .* · aguardando resposta até 18\/11/)).toBeTruthy();
    expect(sentTo("POST", "/send")).toBe(true);
    expect(screen.queryByRole("button", { name: "Emitir e enviar" })).toBeNull();
    const link = screen.getByRole("link", { name: /ND-0012\.json/ });
    expect(link.getAttribute("href")).toBe(`${BASE}/return-note.json`);
  });

  it("#156: o envio recusado pela API mostra a mensagem fixa, sem o código nem o corpo do erro, e o rascunho segue", async () => {
    current = draft;
    onWrite = () => Response.json({ error: "supabase_unavailable", correlationId: "c0ffee-123" }, { status: 502 });
    await openDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Emitir e enviar" }));
    expect(await screen.findByText(t.errors.other)).toBeTruthy();
    expect(region().textContent).not.toMatch(/supabase_unavailable|c0ffee|502/);
    expect(button("Emitir e enviar").disabled).toBe(false);
  });

  it("#156: com o envio falho mostra o motivo fixo e Tentar enviar de novo, sem Descartar nem Editar, e reenvia só pelo /resend", async () => {
    current = sendFailed;
    await openDrawer();
    expect(await screen.findByText(t.sendFailedWithNote("ND-0012", t.sendFailureReasons.resend_unavailable))).toBeTruthy();
    expect(region().textContent).not.toContain("resend_unavailable"); // #156 o código nunca aparece cru
    expect(screen.queryByRole("button", { name: "Descartar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    onWrite = () => {
      current = sent;
      return Response.json({ request: sent });
    };
    fireEvent.click(button("Tentar enviar de novo"));
    expect(await screen.findByText(/emitida e enviada por você/)).toBeTruthy();
    expect(sentTo("POST", "/resend")).toBe(true);
    expect(sentTo("POST", "/send")).toBe(false); // #156 reenviar nunca emite outra nota
  });

  it("#156: o envio que falha na hora vira o estado envio falho (200 com send_failed)", async () => {
    current = draft;
    onWrite = () => Response.json({ request: sendFailed });
    await openDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Emitir e enviar" }));
    expect(await screen.findByText(t.sendFailedWithNote("ND-0012", t.sendFailureReasons.resend_unavailable))).toBeTruthy();
    expect(button("Tentar enviar de novo")).toBeTruthy();
  });

  it("#156: Editar libera só o texto, com o molde e os marcadores; salvar manda PATCH com `template`", async () => {
    current = draft;
    await openDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(box.value).toBe(TEMPLATE);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(button("Emitir e enviar").disabled).toBe(true);
    expect(button("Descartar").disabled).toBe(true);
    const edited = "Na NF {{nota_numero}} veio {{item_quantidade}} no lugar do pedido. Agradecemos.";
    onWrite = () => {
      current = { ...draft, email: { ...draft.email, body: `${MAIL_TEXT} Agradecemos.`, template: edited } };
      return Response.json({ request: current });
    };
    fireEvent.change(box, { target: { value: edited } });
    fireEvent.click(button("Salvar texto"));
    expect(await screen.findByText(/Agradecemos\./)).toBeTruthy();
    expect(calls.find((c) => c.method === "PATCH")).toEqual({ method: "PATCH", path: BASE, body: { template: edited } });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("#156: Cancelar edição fecha a edição sem chamar a API", async () => {
    current = draft;
    await openDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar edição" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("#156: o texto com número fora do banco (422) mostra a mensagem fixa e a edição segue aberta com o que foi digitado", async () => {
    current = draft;
    onWrite = () => Response.json({ error: "invalid", reason: "number_mismatch", field: "body" }, { status: 422 });
    await openDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Devolvemos 99 itens." } });
    fireEvent.click(button("Salvar texto"));
    expect(await screen.findByText(t.errors.unprocessable)).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Devolvemos 99 itens.");
    expect(region().textContent).not.toMatch(/number_mismatch|invalid_shape/);
  });

  it("#156: Descartar, sem confirmação, leva ao descartado, e Refazer volta a escrevendo", async () => {
    current = draft;
    onWrite = (_method, path) => {
      current = path.endsWith("/discard")
        ? { status: "discarded", discardedAt: "2026-11-15T13:41:00Z", discardedBy: "ana@jachegou.test" }
        : { status: "writing" };
      return Response.json({ request: current });
    };
    await openDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Descartar" }));
    expect(await screen.findByText(/Pedido descartado por você às/)).toBeTruthy();
    fireEvent.click(button("Refazer"));
    expect(await screen.findByText(t.writing)).toBeTruthy();
    expect(sentTo("POST", "/discard")).toBe(true);
    expect(sentTo("POST", "/redo")).toBe(true);
  });

  it("#156: sem rascunho por número fora do catálogo, mostra o motivo fixo e Refazer, sem nota nem e-mail", async () => {
    current = { status: "failed", failure: "number_mismatch" };
    await openDrawer();
    expect(await screen.findByText(t.notPrepared(t.notPreparedReasons.number_mismatch))).toBeTruthy();
    expect(region().textContent).not.toContain("number_mismatch");
    expect(screen.queryByRole("button", { name: "Emitir e enviar" })).toBeNull();
    onWrite = () => {
      current = { status: "writing" };
      return Response.json({ request: current });
    };
    fireEvent.click(button("Refazer"));
    expect(await screen.findByText(t.writing)).toBeTruthy();
    expect(sentTo("POST", "/redo")).toBe(true);
  });

  it("#156: a leitura que falha mostra Não foi possível carregar o pedido, sem o erro, e Tentar de novo busca outra vez", async () => {
    current = draft;
    readStatus = 500;
    await openDrawer();
    expect(await screen.findByText("Não foi possível carregar o pedido")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Pedido ao fornecedor" })).toBeNull();
    expect(document.body.textContent).not.toContain("internal_error");
    readStatus = 200;
    fireEvent.click(button("Tentar de novo"));
    expect(await screen.findByRole("region", { name: "Pedido ao fornecedor" })).toBeTruthy();
    expect(screen.queryByText("Não foi possível carregar o pedido")).toBeNull();
  });

  it("#156: cinco consultas seguidas que falham enquanto escreve trocam o bloco pelo alerta com Tentar de novo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    current = { status: "writing" };
    await openDrawer();
    expect(await screen.findByText(t.writing)).toBeTruthy();
    readStatus = 503;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 3000 + 100);
    });
    expect(await screen.findByText("Não foi possível carregar o pedido")).toBeTruthy();
    expect(button("Tentar de novo")).toBeTruthy();
  });
});

describe("#156 página inteira: acessibilidade da gaveta montada (#156)", () => {
  // #156 Sem axe no projeto, a verificação de página é por papéis e nomes do Testing Library sobre a gaveta toda.
  it("#156: uma só região chamada Pedido ao fornecedor, título dentro dela, botões nomeados e controles focáveis", async () => {
    current = draft;
    await openDrawer();
    await screen.findByRole("region", { name: "Pedido ao fornecedor" });
    expect(screen.getAllByRole("region", { name: "Pedido ao fornecedor" })).toHaveLength(1);
    expect(within(region()).getByText("Pedido ao fornecedor")).toBeTruthy();
    const buttons = screen.getAllByRole("button");
    for (const control of buttons) {
      expect((control.getAttribute("aria-label") ?? control.textContent ?? "").trim(), "botão sem nome").not.toBe("");
    }
    for (const name of ["Emitir e enviar", "Editar", "Descartar"]) {
      const control = within(region()).getByRole("button", { name });
      control.focus();
      expect(document.activeElement).toBe(control);
    }
  });

  it("#156: na edição o campo de texto tem nome e recebe o foco, e a ordem de leitura vai da decisão ao bloco", async () => {
    current = draft;
    await openDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const box = await screen.findByRole("textbox", { name: t.email.bodyLabel });
    box.focus();
    expect(document.activeElement).toBe(box);
    expect(screen.getAllByRole("region", { name: "Pedido ao fornecedor" })).toHaveLength(1);
    expect(screen.getByText("Decisão registrada").compareDocumentPosition(region()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("#156: depois do envio o anexo é um link com nome, e continua uma só região", async () => {
    current = sent;
    await openDrawer();
    await screen.findByRole("region", { name: "Pedido ao fornecedor" });
    expect(within(region()).getByRole("link", { name: /ND-0012\.json/ })).toBeTruthy();
    expect(screen.getAllByRole("region", { name: "Pedido ao fornecedor" })).toHaveLength(1);
  });
});
