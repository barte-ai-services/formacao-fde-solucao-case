import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { texts } from "../texts";
import type { SupplierRequestView } from "./SupplierRequestBlock";
import { SupplierRequestSection } from "./SupplierRequestSection";
import type { SupplierRequestPort } from "./supplier-request-state";

// #156 O bloco "Pedido ao fornecedor" ligado ao estado (#156), pelo componente de verdade e com as chamadas trocadas por funções (#156).
// A busca por papel e rótulo é a verificação de acessibilidade do projeto (#156).

const KEY = "35261100000000000000550010000080001000080001";
const VIEWER = "ana@jachegou.test";
const SENT_AT = "2026-11-15T13:40:00Z";
const email = { to: "fiscal@higienetotal.test", dueOn: "2026-11-18", subject: "NF 20046 · devolução", body: "Na NF 20046 veio item trocado.", template: "Na NF {{numero}} veio item trocado." };
const note = { number: "ND-0012", lines: [], total: { text: "R$ 2.463,20" } };
const draft: SupplierRequestView = { status: "draft", returnNote: note, email };
const t = texts.supplierRequest;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function port(initial: SupplierRequestView | null, over: Partial<SupplierRequestPort> = {}): SupplierRequestPort {
  return {
    load: vi.fn(async () => initial),
    send: vi.fn(async () => ({ status: "sent", sentBy: VIEWER, sentAt: SENT_AT, returnNote: note, email }) as SupplierRequestView),
    resend: vi.fn(async () => ({ status: "sent", sentBy: VIEWER, sentAt: SENT_AT, returnNote: note, email }) as SupplierRequestView),
    discard: vi.fn(async () => ({ status: "discarded", discardedAt: SENT_AT }) as SupplierRequestView),
    redo: vi.fn(async () => ({ status: "writing" }) as SupplierRequestView),
    saveTemplate: vi.fn(async (_key: string, template: string) => ({ status: "draft", returnNote: note, email: { ...email, body: template, template } }) as SupplierRequestView),
    ...over,
  };
}

const show = (p: SupplierRequestPort, pollMs = 20) =>
  render(<SupplierRequestSection source={{ port: p, viewer: VIEWER, pollMs }} accessKey={KEY} />);
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const click = (name: string) => fireEvent.click(button(name));
const region = () => screen.getByRole("region", { name: t.title });

describe("#156 pedido ao fornecedor: carregar", () => {
  it("#156: sem pedido na nota, nada é desenhado", async () => {
    const p = port(null);
    const { container } = show(p);
    await waitFor(() => expect(p.load).toHaveBeenCalledWith(KEY, expect.any(AbortSignal)));
    expect(container.innerHTML).toBe("");
  });

  it("#156: com rascunho, mostra o rascunho e os botões", async () => {
    show(port(draft));
    expect(await screen.findByRole("button", { name: t.actions.sendWithNote })).toBeTruthy();
    expect(button(t.actions.edit)).toBeTruthy();
    expect(button(t.actions.discard)).toBeTruthy();
  });
});

describe("#156 pedido ao fornecedor: escrevendo e a consulta periódica", () => {
  it("#156: escrevendo, consulta de novo e troca para o rascunho quando fica pronto", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockResolvedValueOnce({ status: "writing" }).mockResolvedValue(draft);
    show(port(null, { load }));
    expect(await screen.findByText(t.writing)).toBeTruthy();
    expect(await screen.findByRole("button", { name: t.actions.sendWithNote })).toBeTruthy();
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("#156: uma consulta que falha mantém o escrevendo e a próxima tenta de novo", async () => {
    const load = vi
      .fn<SupplierRequestPort["load"]>()
      .mockResolvedValueOnce({ status: "writing" })
      .mockRejectedValueOnce(new ApiError(500, null, "corpo cru"))
      .mockResolvedValue(draft);
    show(port(null, { load }));
    expect(await screen.findByText(t.writing)).toBeTruthy();
    expect(await screen.findByRole("button", { name: t.actions.sendWithNote })).toBeTruthy();
    expect(screen.queryByText(/corpo cru/)).toBeNull();
  });

  it("#156: com o rascunho na tela, não consulta mais", async () => {
    const p = port(draft);
    show(p);
    await screen.findByRole("button", { name: t.actions.sendWithNote });
    const calls = vi.mocked(p.load).mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(vi.mocked(p.load).mock.calls.length).toBe(calls);
  });
});

describe("#156 pedido ao fornecedor: emitir e enviar", () => {
  it("#156: Emitir e enviar trava os botões e troca o texto; ao terminar mostra emitida e enviada", async () => {
    const pending = deferred<SupplierRequestView>();
    const p = port(draft, { send: vi.fn(() => pending.promise) });
    show(p);
    await screen.findByRole("button", { name: t.actions.sendWithNote });
    click(t.actions.sendWithNote);
    expect(p.send).toHaveBeenCalledWith(KEY);
    const busy = await screen.findByRole("button", { name: t.pending.sendWithNote });
    expect(region().parentElement?.getAttribute("aria-busy") ?? null).toBe("true");
    for (const b of screen.getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(busy).toBeTruthy();
    pending.resolve({ status: "sent", sentBy: VIEWER, sentAt: SENT_AT, returnNote: note, email });
    expect(await screen.findByText(/Nota de devolução ND-0012 emitida e enviada por você/)).toBeTruthy();
    expect(region().parentElement?.getAttribute("aria-busy") ?? null).toBeNull();
  });

  it.each([
    [403, t.errors.forbidden],
    [409, t.errors.conflict],
    [422, t.errors.unprocessable],
    [500, t.errors.other],
  ])("#156: a recusa %i mostra só a mensagem do texto e o bloco volta ao rascunho", async (status, message) => {
    const p = port(draft, { send: vi.fn(async () => Promise.reject(new ApiError(status, "codigo_interno", "SQLSTATE 23505 corpo cru"))) });
    show(p);
    await screen.findByRole("button", { name: t.actions.sendWithNote });
    click(t.actions.sendWithNote);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(region().textContent).not.toMatch(/SQLSTATE|codigo_interno|corpo cru/);
    expect(button(t.actions.sendWithNote).disabled).toBe(false);
    expect(region().parentElement?.getAttribute("aria-busy") ?? null).toBeNull();
  });

  it("#156: a falha de rede (status 0) também mostra só a mensagem genérica", async () => {
    const p = port(draft, { send: vi.fn(async () => Promise.reject(new TypeError("Failed to fetch https://interno"))) });
    show(p);
    await screen.findByRole("button", { name: t.actions.sendWithNote });
    click(t.actions.sendWithNote);
    expect(await screen.findByText(t.errors.other)).toBeTruthy();
    expect(region().textContent).not.toMatch(/Failed to fetch|interno/);
  });

  it("#156: o envio que estoura o prazo mostra o que o servidor concluiu, com a mensagem fixa e sem o texto do erro", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockResolvedValueOnce(draft).mockResolvedValue({ status: "sent", sentBy: VIEWER, sentAt: SENT_AT, returnNote: note, email });
    const send = vi.fn(async () => Promise.reject(new ApiError(0, null, "prazo https://interno")));
    show(port(draft, { load, send }));
    await screen.findByRole("button", { name: t.actions.sendWithNote });
    click(t.actions.sendWithNote);
    expect(await screen.findByText(t.errors.timeout)).toBeTruthy();
    expect(await screen.findByText(/Nota de devolução ND-0012 emitida e enviada/)).toBeTruthy();
    expect(region().textContent).not.toMatch(/interno/);
  });

  it("#156: tentar de novo depois do erro limpa a mensagem anterior", async () => {
    const send = vi.fn<SupplierRequestPort["send"]>().mockRejectedValueOnce(new ApiError(409, null, "x"));
    send.mockResolvedValue({ status: "sent", sentBy: VIEWER, sentAt: SENT_AT, email });
    show(port(draft, { send }));
    await screen.findByRole("button", { name: t.actions.sendWithNote });
    click(t.actions.sendWithNote);
    await screen.findByText(t.errors.conflict);
    click(t.actions.sendWithNote);
    await waitFor(() => expect(screen.queryByText(t.errors.conflict)).toBeNull());
  });
});

describe("#156 pedido ao fornecedor: envio falho e reenvio", () => {
  const failed: SupplierRequestView = { status: "send_failed", failure: "resend_unavailable", returnNote: note, email };

  it("#156: o envio que falha mostra a nota emitida e Tentar enviar de novo", async () => {
    const p = port(draft, { send: vi.fn(async () => failed) });
    show(p);
    await screen.findByRole("button", { name: t.actions.sendWithNote });
    click(t.actions.sendWithNote);
    expect(await screen.findByText(t.sendFailedWithNote("ND-0012", t.sendFailureReasons.resend_unavailable))).toBeTruthy();
    expect(button(t.actions.resend)).toBeTruthy();
  });

  it("#156: Tentar enviar de novo só reenvia: não emite de novo, e termina em enviada", async () => {
    const pending = deferred<SupplierRequestView>();
    const p = port(failed, { resend: vi.fn(() => pending.promise) });
    show(p);
    await screen.findByRole("button", { name: t.actions.resend });
    click(t.actions.resend);
    expect(await screen.findByRole("button", { name: t.pending.resend })).toBeTruthy();
    pending.resolve({ status: "sent", sentBy: VIEWER, sentAt: SENT_AT, returnNote: note, email });
    expect(await screen.findByText(/emitida e enviada por você/)).toBeTruthy();
    expect(p.resend).toHaveBeenCalledWith(KEY);
    expect(p.send).not.toHaveBeenCalled();
  });

  it("#156: o reenvio recusado fica em envio falho com a mensagem do status", async () => {
    const p = port(failed, { resend: vi.fn(async () => Promise.reject(new ApiError(403, null, "corpo cru"))) });
    show(p);
    await screen.findByRole("button", { name: t.actions.resend });
    click(t.actions.resend);
    expect(await screen.findByText(t.errors.forbidden)).toBeTruthy();
    expect(button(t.actions.resend).disabled).toBe(false);
  });
});

describe("#156 pedido ao fornecedor: editar só o texto", () => {
  it("#156: Editar abre o texto com Salvar texto e Cancelar edição; Descartar e Emitir ficam travados", async () => {
    show(port(draft));
    await screen.findByRole("button", { name: t.actions.edit });
    click(t.actions.edit);
    const box = screen.getByRole("textbox", { name: t.email.bodyLabel }) as HTMLTextAreaElement;
    // #156 A edição abre com o texto com os marcadores {{…}} (Q3 emendada do wireframe), não com o texto já preenchido.
    expect(box.value).toBe(email.template);
    expect(button(t.actions.save)).toBeTruthy();
    expect(button(t.actions.cancelEdit)).toBeTruthy();
    expect(button(t.actions.discard).disabled).toBe(true);
    expect(button(t.actions.sendWithNote).disabled).toBe(true);
  });

  it("#156: Salvar texto manda o texto digitado e volta ao rascunho com ele", async () => {
    const p = port(draft);
    show(p);
    await screen.findByRole("button", { name: t.actions.edit });
    click(t.actions.edit);
    fireEvent.change(screen.getByRole("textbox", { name: t.email.bodyLabel }), { target: { value: "Texto corrigido" } });
    click(t.actions.save);
    expect(await screen.findByText("Texto corrigido")).toBeTruthy();
    expect(p.saveTemplate).toHaveBeenCalledWith(KEY, "Texto corrigido");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(button(t.actions.sendWithNote).disabled).toBe(false);
  });

  it("#156: durante o salvamento o principal diz Salvando… e tudo fica travado", async () => {
    const pending = deferred<SupplierRequestView>();
    show(port(draft, { saveTemplate: vi.fn(() => pending.promise) }));
    await screen.findByRole("button", { name: t.actions.edit });
    click(t.actions.edit);
    click(t.actions.save);
    expect(await screen.findByRole("button", { name: t.pending.save })).toBeTruthy();
    expect(button(t.actions.cancelEdit).disabled).toBe(true);
    pending.resolve(draft);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("#156: o servidor recusa o texto (422): o erro aparece e a edição segue aberta com o texto digitado", async () => {
    const p = port(draft, { saveTemplate: vi.fn(async () => Promise.reject(new ApiError(422, "numeros_divergem", "número 99 não confere"))) });
    show(p);
    await screen.findByRole("button", { name: t.actions.edit });
    click(t.actions.edit);
    fireEvent.change(screen.getByRole("textbox", { name: t.email.bodyLabel }), { target: { value: "Valor 99" } });
    click(t.actions.save);
    expect(await screen.findByText(t.errors.unprocessable)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: t.email.bodyLabel }) as HTMLTextAreaElement).value).toBe("Valor 99");
    expect(region().textContent).not.toMatch(/numeros_divergem|número 99/);
  });

  it("#156: Cancelar edição volta ao rascunho sem chamar o servidor", async () => {
    const p = port(draft);
    show(p);
    await screen.findByRole("button", { name: t.actions.edit });
    click(t.actions.edit);
    fireEvent.change(screen.getByRole("textbox", { name: t.email.bodyLabel }), { target: { value: "descartado" } });
    click(t.actions.cancelEdit);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("descartado")).toBeNull();
    expect(p.saveTemplate).not.toHaveBeenCalled();
  });
});

describe("#156 pedido ao fornecedor: descartar e refazer", () => {
  it("#156: Descartar não pergunta antes: descarta e oferece Refazer", async () => {
    const p = port(draft);
    show(p);
    await screen.findByRole("button", { name: t.actions.discard });
    click(t.actions.discard);
    expect(p.discard).toHaveBeenCalledWith(KEY);
    expect(await screen.findByText(/Pedido descartado por você/)).toBeTruthy();
    expect(button(t.actions.redo)).toBeTruthy();
  });

  it("#156: Refazer pede um rascunho novo e o bloco volta a escrevendo, depois ao rascunho", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockResolvedValueOnce({ status: "discarded", discardedAt: SENT_AT }).mockResolvedValue(draft);
    const p = port(null, { load });
    show(p);
    await screen.findByRole("button", { name: t.actions.redo });
    click(t.actions.redo);
    expect(p.redo).toHaveBeenCalledWith(KEY);
    expect(await screen.findByText(t.writing)).toBeTruthy();
    expect(await screen.findByRole("button", { name: t.actions.sendWithNote })).toBeTruthy();
  });

  it("#156: com o pedido que não foi possível preparar, Refazer volta a escrevendo", async () => {
    const p = port({ status: "failed", failure: "number_mismatch" });
    show(p);
    expect(await screen.findByText(t.notPrepared(t.notPreparedReasons.number_mismatch))).toBeTruthy();
    click(t.actions.redo);
    expect(await screen.findByText(t.writing)).toBeTruthy();
    expect(p.redo).toHaveBeenCalledWith(KEY);
  });

  it("#156: Refazer recusado (409) mostra o pedido para reabrir a gaveta e o botão segue", async () => {
    const p = port({ status: "discarded", discardedAt: SENT_AT }, { redo: vi.fn(async () => Promise.reject(new ApiError(409, null, "corpo cru"))) });
    show(p);
    await screen.findByRole("button", { name: t.actions.redo });
    click(t.actions.redo);
    expect(await screen.findByText(t.errors.conflict)).toBeTruthy();
    expect(button(t.actions.redo).disabled).toBe(false);
  });
});

describe("#156 pedido ao fornecedor: não foi possível carregar", () => {
  const boom = () => new ApiError(500, "codigo_interno", "SQLSTATE 23505 corpo cru");

  it("#156: a carga inicial que falha mostra o alerta e Tentar de novo, sem o texto do erro", async () => {
    const p = port(null, { load: vi.fn(async () => Promise.reject(boom())) });
    show(p);
    expect(await screen.findByText(t.loadFailed.title)).toBeTruthy();
    expect(button(t.loadFailed.retry)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SQLSTATE|codigo_interno|corpo cru/);
  });

  it("#156: Tentar de novo recarrega e o bloco volta ao rascunho", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockRejectedValueOnce(boom()).mockResolvedValue(draft);
    show(port(null, { load }));
    await screen.findByText(t.loadFailed.title);
    click(t.loadFailed.retry);
    expect(await screen.findByRole("button", { name: t.actions.sendWithNote })).toBeTruthy();
    expect(screen.queryByText(t.loadFailed.title)).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("#156: 5 consultas seguidas que falham enquanto escreve trocam o bloco pelo alerta, e Tentar de novo mostra o pedido pronto", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockResolvedValueOnce({ status: "writing" });
    for (let i = 0; i < 5; i += 1) load.mockRejectedValueOnce(boom());
    load.mockResolvedValue(draft);
    show(port(null, { load }), 5);
    expect(await screen.findByText(t.loadFailed.title)).toBeTruthy();
    expect(screen.queryByText(t.writing)).toBeNull();
    expect(document.body.textContent).not.toMatch(/SQLSTATE|codigo_interno|corpo cru/);
    click(t.loadFailed.retry);
    expect(await screen.findByRole("button", { name: t.actions.sendWithNote })).toBeTruthy();
  });
});
