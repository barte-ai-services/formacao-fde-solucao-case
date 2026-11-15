import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { pendingSince } from "../src/routes/devolucoes";
import { fallbackContext } from "../src/shell/context";

// #140 A tela "Notas de devolução" contra uma API falsa, no formato de api/src/returns/return-notes.ts.

const note = {
  id: 7,
  status: "pendente",
  invoiceAccessKey: "35261154813096000149550010000706331730119123",
  invoiceNumber: "70633",
  supplierId: "F05",
  reason: "E3 quantidade menor na nota 70633: devolução da diferença",
  lines: [{ supplierCode: "FEI-01", description: "Feijão carioca 1 kg", quantity: { amount: 20, unit: "UN" }, valueCents: 12500 }],
  valueCents: 12500,
  publishedAt: "2026-11-15T12:30:00Z",
  pendingSeconds: 9000,
  emitted: null,
  cancelled: null,
};

describe("#140 pendingSince", () => {
  it.each([
    [30, "há menos de 1 min"],
    [600, "há 10 min"],
    [9000, "há 2 h 30 min"],
    [7200, "há 2 h"],
    [3 * 86400 + 3600, "há 3 dias"],
    [null, "—"],
  ])("%s s vira %s", (seconds, text) => expect(pendingSince(seconds)).toBe(text));
});

describe("#140 /devolucoes", () => {
  const respond = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST") {
      return Response.json({ ...note, status: path.endsWith("/issue") ? "emitida" : "cancelada" });
    }
    return Response.json({ notes: [note] });
  };
  const fetchMock = vi.fn(respond);
  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockClear();
    fetchMock.mockImplementation(respond);
  });

  function renderRoute() {
    window.history.replaceState(null, "", "/devolucoes");
    return render(<Frame context={fallbackContext("fiscal@barte.com")} />);
  }

  it("AC-2 mostra nota de origem, fornecedor, itens e quantidades, valor, motivo e há quanto tempo", async () => {
    renderRoute();
    const row = (await screen.findByText("NF 70633")).closest("tr")!;
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/return-notes");
    expect(within(row).getByText("F05")).toBeTruthy();
    expect(within(row).getByText("20 UN de Feijão carioca 1 kg")).toBeTruthy();
    expect(within(row).getByText(/R\$\s*125,00/)).toBeTruthy();
    expect(within(row).getByText("E3 quantidade menor na nota 70633: devolução da diferença")).toBeTruthy();
    expect(within(row).getByText("há 2 h 30 min")).toBeTruthy();
  });

  it("AC-3 marcar como emitida pede o número da NF-e e o envia", async () => {
    renderRoute();
    fireEvent.click((await screen.findByText("NF 70633")).closest("tr")!);
    fireEvent.click(await screen.findByRole("button", { name: "Marcar como emitida" }));
    expect(await screen.findByText("Informe o número da NF-e de devolução.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.change(screen.getByLabelText("Número da NF-e de devolução"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Marcar como emitida" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
      expect(String(post[0])).toBe("/api/return-notes/7/issue");
      expect(JSON.parse(String(post[1]!.body))).toEqual({ nfeNumber: "123456" });
    });
  });

  it("cancelar exige a justificativa e a envia", async () => {
    renderRoute();
    fireEvent.click((await screen.findByText("NF 70633")).closest("tr")!);
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar nota" }));
    expect(await screen.findByText("Explique por que a devolução foi cancelada.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Justificativa do cancelamento"), { target: { value: "Crédito do fornecedor" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar nota" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
      expect(String(post[0])).toBe("/api/return-notes/7/cancel");
      expect(JSON.parse(String(post[1]!.body))).toEqual({ justification: "Crédito do fornecedor" });
    });
  });

  it("nota já decidida por outra pessoa mostra o aviso de conflito", async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ notes: [note] }));
    // #211 A faixa de automação também chama a API: só o POST leva o 409.
    fetchMock.mockImplementation(async (_input, init) =>
      init?.method === "POST" ? Response.json({ error: "already_decided" }, { status: 409 }) : Response.json({ notes: [note] }),
    );
    renderRoute();
    fireEvent.click((await screen.findByText("NF 70633")).closest("tr")!);
    fireEvent.change(await screen.findByLabelText("Número da NF-e de devolução"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Marcar como emitida" }));
    expect(await screen.findByText("Esta nota já foi decidida por outra pessoa.")).toBeTruthy();
  });

  it("#123 sem devolução pendente, mostra o estado vazio com a ação para a fila", async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ notes: [] }));
    renderRoute();
    expect(await screen.findByText("Nenhuma devolução pendente de emissão")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ver a fila de aprovação" })).toBeTruthy();
  });

  it("#207/AC-1 #207/AC-3 o filtro de situação é a pílula densa da fila, sem contador, e escolher uma situação recarrega a lista", async () => {
    const { container } = renderRoute();
    await screen.findByText("NF 70633");
    const group = screen.getByRole("radiogroup", { name: "Filtrar por situação" });
    expect(container.querySelector(".grid-filter")).toBeTruthy();
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Pendentes de emissão", "Emitidas", "Canceladas"]);
    expect(radios.some((r) => /\d/.test(r.textContent ?? ""))).toBe(false);
    expect(screen.getByRole("radio", { name: "Pendentes de emissão" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Emitidas" }).getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector("select")).toBeNull();

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "Emitidas" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/return-notes?status=emitida")).toBe(true));
    expect(screen.getByRole("radio", { name: "Emitidas" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Pendentes de emissão" }).getAttribute("aria-checked")).toBe("false");
  });
});
