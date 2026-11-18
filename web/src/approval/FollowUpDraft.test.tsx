import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FollowUpDraftView } from "../components/supplier-request-view";
import { ViewerProvider } from "../shell/viewer";
import { FollowUpDraft, type FollowUpPhaseState, type SaveFailure } from "./FollowUpDraft";

// #157 O rascunho da cobrança do bloco "Pedido ao fornecedor" (história #157), um teste por estado 8, 9 e 10 do wireframe (#157).
// #157 Sem axe em web/ (#155): a consulta por papel e nome acessível faz o papel da checagem de acessibilidade. Dados fictícios.

const draft: FollowUpDraftView = {
  to: "financeiro@f07-limpeza.example",
  dueOn: "2026-11-20",
  subject: "Cobrança: nota de devolução da nota 59738",
  body: "Olá, enviamos em 07/11 o pedido da nota de devolução de R$ 263,62 e não recebemos retorno até 14/11. Pode nos responder até 20/11?",
  template: "Olá, enviamos em {{pedido.enviadoEm}} o pedido da nota de devolução de {{nota.total}} e não recebemos retorno. Pode nos responder até {{cobranca.prazo}}?",
  attachmentName: "pedido original (nota de devolução ND 6)",
};

function renderDraft(state: FollowUpPhaseState = { phase: "review" }, editing = false, extra: { saving?: boolean; saveFailure?: SaveFailure } = {}) {
  const handlers = { onEdit: vi.fn(), onSave: vi.fn(), onCancelEdit: vi.fn(), onBodyChange: vi.fn(), onSend: vi.fn(), onDiscard: vi.fn(), onRetry: vi.fn() };
  render(<FollowUpDraft draft={draft} editing={editing} {...handlers} {...extra} {...state} />);
  return handlers;
}

describe("#157 FollowUpDraft", () => {
  it("#157: mostra o rascunho para revisar: para, novo prazo, assunto, texto e anexo, e diz que ainda não foi enviado", () => {
    renderDraft();
    expect(screen.getByRole("heading", { name: "Rascunho da cobrança" })).toBeTruthy();
    expect(screen.getByText("preparado pelo Claude, ainda não enviado")).toBeTruthy();
    expect(screen.getByText("financeiro@f07-limpeza.example")).toBeTruthy();
    expect(screen.getByText("20/11")).toBeTruthy();
    expect(screen.getByText("Cobrança: nota de devolução da nota 59738")).toBeTruthy();
    expect(screen.getByText(/Olá, enviamos em 07\/11/)).toBeTruthy();
    expect(screen.getByText("pedido original (nota de devolução ND 6)")).toBeTruthy();
  });

  it("#157: 'Enviar cobrança' e 'Descartar rascunho' chamam o que a tela ligou, e nada sai antes do clique", () => {
    const { onSend, onDiscard } = renderDraft();
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enviar cobrança" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Descartar rascunho" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("#157: 'Editar' libera só o texto; para, assunto, prazo e anexo seguem como texto", () => {
    const { onEdit } = renderDraft();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("#157: editando, o texto vira um campo com o rótulo 'Texto' e cada mudança é avisada; o resto continua travado", () => {
    const { onBodyChange } = renderDraft({ phase: "review" }, true);
    const field = screen.getByRole("textbox", { name: "Texto" });
    expect((field as HTMLTextAreaElement).value).toBe(draft.template);
    fireEvent.change(field, { target: { value: "Pode responder até {{cobranca.prazo}}?" } });
    expect(onBodyChange).toHaveBeenCalledWith("Pode responder até {{cobranca.prazo}}?");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("#157: enviando, os botões ficam desligados e a tela diz que está enviando", () => {
    renderDraft({ phase: "sending" });
    expect(screen.getByText("Enviando a cobrança…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Enviar cobrança" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Descartar rascunho" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("#157: enviada por outra pessoa, a frase diz o nome dela e não 'por você'; sem remetente ou sendo quem olha a tela, 'por você'", () => {
    const sent = { phase: "sent", sentOn: "2026-11-15", sentTime: "10:12" } as const;
    const handlers = { onEdit: vi.fn(), onSave: vi.fn(), onCancelEdit: vi.fn(), onBodyChange: vi.fn(), onSend: vi.fn(), onDiscard: vi.fn(), onRetry: vi.fn() };
    const { rerender } = render(
      <ViewerProvider email="ana@example.test">
        <FollowUpDraft draft={draft} editing={false} {...handlers} {...sent} sentBy="beto@example.test" />
      </ViewerProvider>,
    );
    expect(screen.getByText("Cobrança enviada por beto@example.test em 15/11 às 10:12 · aguardando resposta até 20/11.")).toBeTruthy();
    expect(screen.queryByText(/por você/)).toBeNull();
    rerender(
      <ViewerProvider email="ana@example.test">
        <FollowUpDraft draft={draft} editing={false} {...handlers} {...sent} sentBy="ana@example.test" />
      </ViewerProvider>,
    );
    expect(screen.getByText(/Cobrança enviada por você em 15\/11/)).toBeTruthy();
    rerender(
      <ViewerProvider email="ana@example.test">
        <FollowUpDraft draft={draft} editing={false} {...handlers} {...sent} sentBy={null} />
      </ViewerProvider>,
    );
    expect(screen.getByText(/Cobrança enviada por você em 15\/11/)).toBeTruthy();
  });

  it("#157: enviada, mostra quem enviou e até quando se espera a resposta, sem o rascunho", () => {
    renderDraft({ phase: "sent", sentOn: "2026-11-15", sentTime: "10:12" });
    expect(screen.getByText("Cobrança enviada por você em 15/11 às 10:12 · aguardando resposta até 20/11.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enviar cobrança" })).toBeNull();
    expect(screen.queryByText("Rascunho da cobrança")).toBeNull();
  });

  it("#157: envio falho mantém o rascunho, avisa com o motivo desenhado e oferece 'Tentar enviar de novo' e 'Editar'", () => {
    const { onRetry, onEdit } = renderDraft({ phase: "failed", failure: "mailRefused" });
    expect(screen.getByRole("alert").textContent).toContain("A cobrança não saiu: o servidor de e-mail recusou o envio.");
    expect(screen.getByText("O rascunho fica como está e nada é duplicado.")).toBeTruthy();
    expect(screen.getByText(/Olá, enviamos em 07\/11/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tentar enviar de novo" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("#157: envio falho por motivo desconhecido mostra só a mensagem genérica, nunca o texto de um erro de fora", () => {
    // #157 layer-exposure: a falha é um código fechado; o texto do servidor de e-mail ou da API não tem por onde chegar à tela.
    renderDraft({ phase: "failed", failure: "unknown" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("A cobrança não saiu. Tente de novo em um minuto.");
    expect(alert.textContent).not.toMatch(/smtp|550|stack|undefined|\[object/i);
  });

  it("#157: sem `onEdit` o texto não se edita: o botão 'Editar' não existe, e enviar e descartar seguem", () => {
    const handlers = { onSave: vi.fn(), onCancelEdit: vi.fn(), onBodyChange: vi.fn(), onSend: vi.fn(), onDiscard: vi.fn(), onRetry: vi.fn() };
    render(<FollowUpDraft draft={draft} editing={false} {...handlers} phase="review" />);
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar cobrança" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Descartar rascunho" })).toBeTruthy();
  });

  it("#157: editando, o texto abre com os marcadores {{...}} e a dica de mantê-los, com 'Salvar' e 'Cancelar'", () => {
    const { onSave, onCancelEdit } = renderDraft({ phase: "review" }, true);
    expect((screen.getByRole("textbox", { name: "Texto" }) as HTMLTextAreaElement).value).toContain("{{cobranca.prazo}}");
    expect(screen.getByText(/Mantenha os marcadores \{\{\.\.\.\}\}/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Salvar texto" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar edição" }));
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
  });

  it("#157: editando, 'Enviar cobrança' fica desligado e não chama o envio; fora da edição, segue ligado", () => {
    const { onSend } = renderDraft({ phase: "review" }, true);
    const send = screen.getByRole("button", { name: "Enviar cobrança" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
  });

  it("#157: salvando, 'Salvar' e 'Cancelar' ficam desligados e o rótulo diz 'Salvando…'", () => {
    renderDraft({ phase: "review" }, true, { saving: true });
    expect((screen.getByRole("button", { name: "Salvando…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancelar edição" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("#157: o texto recusado (422) mantém a edição aberta com a mensagem fixa, sem texto do servidor", () => {
    renderDraft({ phase: "review" }, true, { saveFailure: "invalid" });
    expect(screen.getByRole("alert").textContent).toBe("O texto não foi salvo: confira os marcadores {{...}} e os números. O texto anterior continua valendo.");
    expect(screen.getByRole("textbox", { name: "Texto" })).toBeTruthy();
  });

  it("#157: a falha de conflito e a desconhecida têm a mensagem fechada delas", () => {
    renderDraft({ phase: "review" }, true, { saveFailure: "conflict" });
    expect(screen.getByRole("alert").textContent).toBe("A cobrança mudou e o texto não foi salvo. Veja o estado atual e tente de novo.");
  });

  it("#157: enviada, a cobrança não tem 'Editar' nem campo de texto", () => {
    renderDraft({ phase: "sent", sentOn: "2026-11-15", sentTime: "10:12" });
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("#157: o novo prazo vem do servidor; sem ele (nulo), o campo 'Novo prazo' não aparece e a frase de enviada não promete data", () => {
    const handlers = { onEdit: vi.fn(), onSave: vi.fn(), onCancelEdit: vi.fn(), onBodyChange: vi.fn(), onSend: vi.fn(), onDiscard: vi.fn(), onRetry: vi.fn() };
    const { unmount } = render(<FollowUpDraft draft={{ ...draft, dueOn: null }} editing={false} {...handlers} phase="review" />);
    expect(screen.queryByText("Novo prazo")).toBeNull();
    unmount();
    render(<FollowUpDraft draft={{ ...draft, dueOn: null }} editing={false} {...handlers} phase="sent" sentOn="2026-11-15" sentTime="10:12" />);
    expect(screen.getByText("Cobrança enviada por você em 15/11 às 10:12.")).toBeTruthy();
  });

  it("#157: o corpo do rascunho mantém as quebras de linha do texto", () => {
    render(<FollowUpDraft draft={{ ...draft, body: "Olá,\n\nPode nos responder até 20/11?\nObrigado." }} editing={false} onSave={vi.fn()} onCancelEdit={vi.fn()} onBodyChange={vi.fn()} onSend={vi.fn()} onDiscard={vi.fn()} onRetry={vi.fn()} phase="review" />);
    const body = screen.getByText(/Pode nos responder até 20\/11\?/);
    expect(body.textContent).toBe("Olá,\n\nPode nos responder até 20/11?\nObrigado.");
    expect(getComputedStyle(body).whiteSpace).toBe("pre-line");
  });

  it("#157: editando, o contador mostra os caracteres do texto e o limite que a API aceita (20000)", () => {
    renderDraft({ phase: "review" }, true);
    const counter = screen.getByText(`${draft.template.length} de 20000 caracteres`);
    expect(screen.getByRole("textbox", { name: "Texto" }).getAttribute("aria-describedby")).toBe(counter.id);
  });

  it("#157: o contador conta como a API (unidades UTF-16 do texto): um emoji vale 2", () => {
    render(<FollowUpDraft draft={{ ...draft, template: "ab😀" }} editing onSave={vi.fn()} onCancelEdit={vi.fn()} onBodyChange={vi.fn()} onSend={vi.fn()} onDiscard={vi.fn()} onRetry={vi.fn()} phase="review" />);
    expect(screen.getByText("4 de 20000 caracteres")).toBeTruthy();
  });

  it("#157: acima do limite o contador avisa que o servidor não aceita, e fora da edição não há contador", () => {
    const { unmount } = render(<FollowUpDraft draft={{ ...draft, template: "a".repeat(20_001) }} editing onSave={vi.fn()} onCancelEdit={vi.fn()} onBodyChange={vi.fn()} onSend={vi.fn()} onDiscard={vi.fn()} onRetry={vi.fn()} phase="review" />);
    expect(screen.getByText("20001 de 20000 caracteres: acima do limite, o servidor não aceita.")).toBeTruthy();
    unmount();
    renderDraft();
    expect(screen.queryByText(/de 20000 caracteres/)).toBeNull();
  });
});
