import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { texts } from "../texts";
import { SupplierRequestBlock, type SupplierRequestBlockProps, type SupplierRequestView } from "./SupplierRequestBlock";

// #3 O bloco "Pedido ao fornecedor", um teste de renderização por estado do wireframe
// #3 (artifacts/wireframe-pedido-ao-fornecedor/index.html). O bloco é só de apresentação: props entram, callbacks saem.
// A busca por papel e rótulo é a verificação de acessibilidade do projeto (não há workbench nem axe, #15).

const money = (cents: number) => ({ text: `R$ ${(cents / 100).toFixed(2).replace(".", ",")}` });
const MAIL_TEXT = "Na NF 20046 veio Shampoo 350 ml no lugar do Creme dental 90 g pedido.";
const VIEWER = "ana@jachegou.test";
const SENT_AT = "2026-11-15T13:40:00Z";

const returnNote = {
  number: "ND-0012",
  lines: [
    { description: "Shampoo 350 ml", quantity: "40 UN", unitPrice: money(5408), total: money(216_320) },
    { description: "Condicionador 350 ml", quantity: "10 UN", unitPrice: money(3000), total: money(30_000) },
  ],
  total: money(246_320),
};
const email = { to: "fiscal@higienetotal.test", dueOn: "2026-11-18", subject: "NF 20046 · devolução do item trocado", body: MAIL_TEXT, template: "Na NF {{numero}} veio {{item}}." };
const attachment = { name: "nota-devolucao-ND-0012.pdf", url: "/api/supplier-requests/sr-1/return-note.pdf" };

const draft: SupplierRequestView = { status: "draft", returnNote, email, attachment };
const mailOnly = { email };

function setup(request: SupplierRequestView | null, extra: Partial<SupplierRequestBlockProps> = {}) {
  const on = {
    onSend: vi.fn(),
    onDiscard: vi.fn(),
    onEdit: vi.fn(),
    onSave: vi.fn(),
    onCancelEdit: vi.fn(),
    onResend: vi.fn(),
    onRedo: vi.fn(),
    onReload: vi.fn(),
    onDraftTextChange: vi.fn(),
  };
  const view = render(<SupplierRequestBlock request={request} viewer={VIEWER} {...on} {...extra} />);
  return { ...on, container: view.container };
}
const block = () => screen.getByRole("region", { name: "Pedido ao fornecedor" });
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("#3 bloco Pedido ao fornecedor: um estado por vez", () => {
  it("#3/AC-1: com pedido, o bloco traz o título e o selo do Claude, dentro de uma seção", () => {
    setup(draft);
    expect(screen.getByRole("heading", { name: "Pedido ao fornecedor" })).toBeTruthy();
    expect(within(block()).getByText("Claude")).toBeTruthy();
    expect(block().tagName).toBe("SECTION");
  });

  it("#3/AC-1: sem pedido, o bloco não existe, nem o título", () => {
    const { container } = setup(null);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText("Pedido ao fornecedor")).toBeNull();
  });

  it("#3/AC-2: escrevendo mostra que o Claude está preparando, sem botões", () => {
    setup({ status: "writing" });
    expect(screen.getByText("O Claude está preparando o pedido…")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("#3/AC-3: o rascunho mostra a nota (itens, quantidades, valores, total) e o e-mail (para, prazo, assunto, texto, anexo)", () => {
    setup(draft);
    const inBlock = within(block());
    expect(inBlock.getByText("Condicionador 350 ml")).toBeTruthy();
    expect(inBlock.getByText(/40 UN × R\$ 54,08/)).toBeTruthy();
    expect(inBlock.getByText("R$ 2163,20")).toBeTruthy();
    expect(inBlock.getByText("R$ 300,00")).toBeTruthy();
    expect(inBlock.getByText("R$ 2463,20")).toBeTruthy();
    expect(inBlock.getByText("Total da devolução")).toBeTruthy();
    expect(inBlock.getByText("Para: fiscal@higienetotal.test · Prazo: 18/11")).toBeTruthy();
    expect(inBlock.getByText(/NF 20046 · devolução do item trocado/)).toBeTruthy();
    expect(inBlock.getByText(MAIL_TEXT)).toBeTruthy();
    expect(inBlock.getByText("nota-devolucao-ND-0012.pdf (anexa ao enviar)")).toBeTruthy();
    expect(inBlock.queryByRole("link")).toBeNull();
    for (const name of ["Descartar", "Editar", "Emitir e enviar"]) expect(button(name).disabled).toBe(false);
  });

  it("#3/AC-4: o rascunho dispara Emitir e enviar, Descartar e Editar, sem confirmação", () => {
    const on = setup(draft);
    fireEvent.click(button("Emitir e enviar"));
    fireEvent.click(button("Descartar"));
    fireEvent.click(button("Editar"));
    expect(on.onSend).toHaveBeenCalledTimes(1);
    expect(on.onDiscard).toHaveBeenCalledTimes(1);
    expect(on.onEdit).toHaveBeenCalledTimes(1);
  });

  it("#3/AC-4: emitida e enviada mostra a linha de status, o link da nota em nova aba e nenhum botão", () => {
    setup({ status: "sent", returnNote, email, attachment, sentBy: VIEWER, sentAt: SENT_AT });
    expect(screen.getByText(/Nota de devolução ND-0012 emitida e enviada por você às \d{2}h\d{2} · aguardando resposta até 18\/11/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /nota-devolucao-ND-0012\.pdf/ });
    expect(link.getAttribute("href")).toBe("/api/supplier-requests/sr-1/return-note.pdf");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("Ver o que foi enviado")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("#3/AC-4: um anexo com esquema que não é do site nem http(s) não vira link", () => {
    setup({ status: "sent", returnNote, email, attachment: { name: "nota.pdf", url: "javascript:alert(1)" }, sentBy: VIEWER, sentAt: SENT_AT });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("nota.pdf")).toBeTruthy();
  });

  it("#3/AC-4: enviada por outra pessoa diz quem enviou", () => {
    setup({ status: "sent", returnNote, email, attachment, sentBy: "bia@jachegou.test", sentAt: SENT_AT });
    expect(screen.getByText(/emitida e enviada por bia@jachegou\.test às/)).toBeTruthy();
  });

  it("#3/AC-4: a variante sem nota de devolução mostra só o e-mail e Enviar ao fornecedor", () => {
    const on = setup({ status: "draft", ...mailOnly });
    expect(screen.queryByText("Total da devolução")).toBeNull();
    expect(screen.queryByText(/anexa ao enviar/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Emitir e enviar" })).toBeNull();
    fireEvent.click(button("Enviar ao fornecedor"));
    expect(on.onSend).toHaveBeenCalledTimes(1);
  });

  it("#3/AC-4: sem nota, depois de enviado, diz E-mail enviado", () => {
    setup({ status: "sent", ...mailOnly, sentBy: VIEWER, sentAt: SENT_AT });
    expect(screen.getByText(/E-mail enviado por você às \d{2}h\d{2} · aguardando resposta até 18\/11/)).toBeTruthy();
  });

  it("#3/AC-4: sem carimbo (sentBy e sentAt nulos) a linha não traz quem nem a hora", () => {
    setup({ status: "sent", returnNote, email, attachment, sentBy: null, sentAt: null });
    expect(screen.getByText("Nota de devolução ND-0012 emitida e enviada · aguardando resposta até 18/11")).toBeTruthy();
    expect(block().textContent).not.toMatch(/null|Invalid|NaN|--h--|outra pessoa/); // #17
  });

  it("#3/AC-4: sem carimbo e sem nota, o e-mail enviado também fica sem quem e sem hora", () => {
    setup({ status: "sent", ...mailOnly, sentBy: null, sentAt: null });
    expect(screen.getByText("E-mail enviado · aguardando resposta até 18/11")).toBeTruthy();
  });

  it("#3/AC-4: só um dos dois carimbos nulos tira só a parte que falta", () => {
    setup({ status: "sent", returnNote, email, sentBy: "bia@jachegou.test", sentAt: null });
    expect(screen.getByText("Nota de devolução ND-0012 emitida e enviada por bia@jachegou.test · aguardando resposta até 18/11")).toBeTruthy();
    cleanup();
    setup({ status: "sent", returnNote, email, sentBy: null, sentAt: SENT_AT });
    expect(screen.getByText(/^Nota de devolução ND-0012 emitida e enviada às \d{2}h\d{2} · aguardando resposta até 18\/11$/)).toBeTruthy();
  });

  it("#3/AC-5: um código de falha que a tela não conhece vira a frase genérica, nunca o código", () => {
    setup({ status: "send_failed", returnNote, email, attachment, failure: "codigo_novo_do_provedor" });
    expect(block().textContent).not.toContain("codigo_novo_do_provedor"); // #17
    expect(screen.getByText(texts.supplierRequest.sendFailedWithNote("ND-0012", texts.supplierRequest.sendFailureOther))).toBeTruthy();
  });

  it("#3/AC-8: um código de recusa que a tela não conhece vira a frase genérica, nunca o código", () => {
    setup({ status: "failed", failure: "codigo_novo" });
    expect(block().textContent).not.toContain("codigo_novo"); // #17
    expect(screen.getByText(texts.supplierRequest.notPrepared(texts.supplierRequest.notPreparedOther))).toBeTruthy();
  });

  it("#3/AC-4: pendente desabilita todos os botões, troca só o texto do principal e marca o bloco como ocupado", () => {
    setup(draft, { pending: "send" });
    expect(button("Emitindo e enviando…").disabled).toBe(true);
    expect(button("Descartar").disabled).toBe(true);
    expect(button("Editar").disabled).toBe(true);
    expect(block().parentElement?.getAttribute("aria-busy") ?? null).toBe("true");
  });

  it("#3/AC-4: o erro da ação aparece no topo do bloco e os botões seguem habilitados", () => {
    setup(draft, { error: "Você não tem permissão para esta ação." });
    expect(within(block()).getByText("Você não tem permissão para esta ação.")).toBeTruthy();
    expect(button("Emitir e enviar").disabled).toBe(false);
    expect(block().parentElement?.getAttribute("aria-busy") ?? null).not.toBe("true");
  });

  it("#3/AC-5: envio falho mostra o motivo e Tentar enviar de novo, sem Descartar nem Editar", () => {
    const on = setup({ status: "send_failed", returnNote, email, attachment, failure: "resend_unavailable" });
    expect(screen.getByText("A nota ND-0012 foi emitida, mas o e-mail não saiu: o serviço de e-mail está indisponível.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /nota-devolucao-ND-0012\.pdf/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Descartar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    fireEvent.click(button("Tentar enviar de novo"));
    expect(on.onResend).toHaveBeenCalledTimes(1);
  });

  it("#3/AC-5: reenviando desabilita o botão e mostra Reenviando…", () => {
    setup({ status: "send_failed", returnNote, email, attachment, failure: "x" }, { pending: "resend" });
    expect(button("Reenviando…").disabled).toBe(true);
  });

  it("#3/AC-5: sem nota, o envio falho diz O e-mail não saiu", () => {
    setup({ status: "send_failed", ...mailOnly, failure: "send_failed" });
    expect(screen.getByText("O e-mail não saiu: o serviço de e-mail recusou o envio.")).toBeTruthy();
  });

  it("#3/AC-6: editando, só o texto do e-mail é um campo; nota e demais campos ficam travados", () => {
    const on = setup({ status: "editing", returnNote, email, attachment }, { draftText: "Na NF {{numero}} veio {{item}}." });
    const boxes = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.value).toBe("Na NF {{numero}} veio {{item}}."); // #17 o molde, com os marcadores dos números travados
    expect(screen.getByText(/Mantenha os marcadores/)).toBeTruthy();
    expect(screen.getByText("Para, prazo e anexo: travados")).toBeTruthy();
    expect(screen.getByText(/travada/)).toBeTruthy();
    expect(screen.getByText("Os números do texto são conferidos com o banco ao salvar.")).toBeTruthy();
    expect(button("Emitir e enviar").disabled).toBe(true);
    expect(button("Descartar").disabled).toBe(true);
    fireEvent.change(boxes[0]!, { target: { value: "Texto novo da analista." } });
    expect(on.onDraftTextChange).toHaveBeenCalledWith("Texto novo da analista.");
    fireEvent.click(button("Salvar texto"));
    fireEvent.click(button("Cancelar edição"));
    expect(on.onSave).toHaveBeenCalledTimes(1);
    expect(on.onCancelEdit).toHaveBeenCalledTimes(1);
  });

  it("#3/AC-6: salvando desabilita os botões e mostra Salvando…", () => {
    setup({ status: "editing", returnNote, email, attachment }, { draftText: MAIL_TEXT, pending: "save" });
    expect(button("Salvando…").disabled).toBe(true);
    expect(button("Cancelar edição").disabled).toBe(true);
  });

  it("#3/AC-7: descartado mostra quem e quando, e Refazer", () => {
    const on = setup({ status: "discarded", discardedAt: "2026-11-15T13:41:00Z" });
    expect(screen.getByText(/Pedido descartado por você às \d{2}h\d{2}/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Emitir e enviar" })).toBeNull();
    fireEvent.click(button("Refazer"));
    expect(on.onRedo).toHaveBeenCalledTimes(1);
  });

  it("#3/AC-7: sem carimbo (discardedBy e discardedAt nulos) diz só Pedido descartado, e Refazer segue", () => {
    const on = setup({ status: "discarded", discardedAt: null, discardedBy: null });
    expect(screen.getByText("Pedido descartado")).toBeTruthy();
    expect(block().textContent).not.toMatch(/null|Invalid|NaN|--h--|outra pessoa/); // #17
    fireEvent.click(button("Refazer"));
    expect(on.onRedo).toHaveBeenCalledTimes(1);
  });

  it("#3/AC-7: descartado por outra pessoa, sem hora, diz quem e não a hora", () => {
    setup({ status: "discarded", discardedAt: null, discardedBy: "bia@jachegou.test" });
    expect(screen.getByText("Pedido descartado por bia@jachegou.test")).toBeTruthy();
  });

  it("#3/AC-7: refazendo desabilita o botão e mostra Refazendo…", () => {
    setup({ status: "discarded", discardedAt: "2026-11-15T13:41:00Z" }, { pending: "redo" });
    expect(button("Refazendo…").disabled).toBe(true);
  });

  it("#3/AC-8: sem rascunho por falha ou número fora do catálogo, mostra o motivo e Refazer, sem nota nem e-mail", () => {
    const on = setup({ status: "failed", failure: "number_mismatch" });
    expect(screen.getByText("Não foi possível preparar o pedido: o texto citou um número fora do catálogo.")).toBeTruthy();
    expect(screen.queryByText("Total da devolução")).toBeNull();
    expect(screen.queryByRole("button", { name: "Emitir e enviar" })).toBeNull();
    fireEvent.click(button("Refazer"));
    expect(on.onRedo).toHaveBeenCalledTimes(1);
  });
});

describe("#3/AC-9 bloco Pedido ao fornecedor: não foi possível carregar", () => {
  it("#3/AC-9: no lugar do bloco, um alerta de erro com a mensagem fixa e Tentar de novo, sem título nem selo", () => {
    setup(null, { loadFailed: true });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Não foi possível carregar o pedido");
    expect(button("Tentar de novo")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Pedido ao fornecedor" })).toBeNull();
    expect(screen.queryByText("Claude")).toBeNull();
  });

  it("#3/AC-9: Tentar de novo chama o recarregamento", () => {
    const on = setup(null, { loadFailed: true });
    fireEvent.click(button("Tentar de novo"));
    expect(on.onReload).toHaveBeenCalledTimes(1);
  });

  it("#3/AC-9: recarregando, o botão mostra Carregando… e fica travado", () => {
    setup(null, { loadFailed: true, reloading: true });
    expect(button("Carregando…").disabled).toBe(true);
  });

  it("#3/AC-9: a falha de carga vale mesmo com o pedido escrevendo na memória, e nada do pedido aparece", () => {
    setup({ status: "writing" }, { loadFailed: true });
    expect(screen.getByRole("alert").textContent).toContain("Não foi possível carregar o pedido");
    expect(screen.queryByText("O Claude está preparando o pedido…")).toBeNull();
  });

  it("#65/AC-4: no envio falho com nota, o texto diz que tentar de novo não emite outra nota e que descartar não cancela a nota já emitida", () => {
    setup({ status: "send_failed", returnNote, email, attachment, failure: "resend_unavailable" });
    expect(screen.getByText("Tentar de novo só reenvia o e-mail: não emite outra nota. Descartar o pedido não cancela a nota já emitida.")).toBeTruthy();
  });

  it("#65/AC-4: no envio falho sem nota, não há o que dizer sobre nota emitida", () => {
    setup({ status: "send_failed", ...mailOnly, failure: "send_failed" });
    expect(screen.queryByText(/não emite outra nota/)).toBeNull();
  });

  it("#65/AC-6: o rascunho com anexo mostra a dica com o nome real, com o clipe: '📎 nota-devolucao-ND-0012.pdf (anexa ao enviar)'", () => {
    setup(draft);
    const hint = screen.getByText("nota-devolucao-ND-0012.pdf (anexa ao enviar)");
    expect(hint.textContent).toContain("📎");
    expect(hint.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe("📎");
  });

  it("#65/AC-6: o rascunho com nota e sem nome de anexo (a nota ainda não foi emitida) segue o wireframe: '📎 nota-devolucao-…pdf (anexa ao enviar)'", () => {
    setup({ status: "draft", returnNote: { ...returnNote, number: null }, email });
    const hint = screen.getByText("nota-devolucao-…pdf (anexa ao enviar)");
    expect(hint.textContent).toContain("📎");
  });

  it("#65/AC-6: o rascunho só de e-mail não tem anexo, nem dica", () => {
    setup({ status: "draft", ...mailOnly });
    expect(screen.queryByText(/anexa ao enviar/)).toBeNull();
  });
});
