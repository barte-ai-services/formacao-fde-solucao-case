import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SupplierRequestList, type SupplierRequestListProps } from "./SupplierRequestList";
import type { SupplierRequestRow } from "./supplier-request-view";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("../router", () => ({ navigate }));

// #19 A lista "Pedidos ao fornecedor" por props, um teste por estado do wireframe aprovado (#18). Sem Storybook nem axe em web/ (#25):
// #19 a consulta por papel e nome acessível faz o papel da checagem de acessibilidade. Dados fictícios.

const late: SupplierRequestRow = {
  id: "sr-1",
  invoiceNumber: "59738",
  supplier: "F07 Limpeza",
  request: "Nota de devolução",
  amountCents: 26362,
  dueOn: "2026-11-14",
  status: "late",
};
const lateToo: SupplierRequestRow = { ...late, id: "sr-2", invoiceNumber: "40519", supplier: "F09 Embalagens", amountCents: 154090, dueOn: "2026-11-12" };
const waiting: SupplierRequestRow = { ...late, id: "sr-3", invoiceNumber: "51877", supplier: "F02 Bebidas", amountCents: 98000, dueOn: "2026-11-20", status: "waiting" };
const toConfirm: SupplierRequestRow = { ...late, id: "sr-4", invoiceNumber: "20046", supplier: "F11 Higiene", dueOn: "2026-11-18", status: "fulfilledToConfirm", document: "ND 881" };

function renderList(props: Partial<SupplierRequestListProps> = {}) {
  const handlers = { onFilterChange: vi.fn(), onOpenRow: vi.fn(), onFollowUp: vi.fn(), onRetry: vi.fn(), onShowAll: vi.fn() };
  render(
    <SupplierRequestList
      state="ready"
      filter="late"
      counts={{ waiting: 7, fulfilled: 12, needsYou: 3, late: 2 }}
      rows={[late, lateToo]}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("#19 SupplierRequestList", () => {
  it("#5/AC-1: mostra o título, o subtítulo e as seis colunas Nota, Fornecedor, Solicitação, Valor, Prazo e Status", () => {
    renderList();
    expect(screen.getByRole("heading", { name: "Pedidos ao fornecedor" })).toBeTruthy();
    expect(screen.getByText("O que pedimos aos fornecedores, quem respondeu e quem está devendo resposta.")).toBeTruthy();
    for (const header of ["Nota", "Fornecedor", "Solicitação", "Valor", "Prazo", "Status"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }
  });

  it("#5/AC-1: cada linha traz nota, fornecedor, solicitação, valor, prazo e status, na ordem recebida", () => {
    renderList();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByText("NF 59738")).toBeTruthy();
    expect(first.getByText("F07 Limpeza")).toBeTruthy();
    expect(first.getByText("Nota de devolução")).toBeTruthy();
    expect(first.getByText(/R\$\s*263,62/)).toBeTruthy();
    expect(first.getByText("14/11")).toBeTruthy();
    expect(first.getByText("Atrasado")).toBeTruthy();
    expect(within(rows[1]!).getByText("F09 Embalagens")).toBeTruthy();
  });

  it("#5/AC-2: os quatro chips são radios com a contagem, e o do filtro está marcado", () => {
    renderList();
    const late = screen.getByRole("radio", { name: /^Atrasados/ });
    expect(late.getAttribute("aria-checked")).toBe("true");
    expect(late.textContent).toMatch(/2/);
    expect(screen.getByRole("radio", { name: /^Aguardando/ }).textContent).toMatch(/7/);
    expect(screen.getByRole("radio", { name: /^Atendidos/ }).textContent).toMatch(/12/);
    expect(screen.getByRole("radio", { name: /^Precisam de você/ }).textContent).toMatch(/3/);
  });

  it("#5/AC-2: escolher um chip avisa o filtro escolhido", () => {
    const { onFilterChange } = renderList();
    fireEvent.click(screen.getByRole("radio", { name: /^Aguardando/ }));
    expect(onFilterChange).toHaveBeenCalledWith("waiting");
  });

  it("#5/AC-3: a linha abre a gaveta pelo clique e pelo teclado, com o rótulo 'Nota 59738, F07 Limpeza'", () => {
    const { onOpenRow } = renderList();
    const row = screen.getByRole("row", { name: "Nota 59738, F07 Limpeza" });
    fireEvent.click(row);
    expect(onOpenRow).toHaveBeenCalledWith(late);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpenRow).toHaveBeenCalledTimes(2);
  });

  it("#5/AC-4: 'Cobrar' na linha atrasada pede o rascunho e não abre a linha", () => {
    const { onFollowUp, onOpenRow } = renderList();
    const row = screen.getByRole("row", { name: "Nota 59738, F07 Limpeza" });
    fireEvent.click(within(row).getByRole("button", { name: "Cobrar" }));
    expect(onFollowUp).toHaveBeenCalledWith(late);
    expect(onOpenRow).not.toHaveBeenCalled();
  });

  it("#5/AC-4: só a linha atrasada tem 'Cobrar'", () => {
    renderList({ filter: "all", rows: [waiting, toConfirm, late] });
    expect(screen.getAllByRole("button", { name: "Cobrar" })).toHaveLength(1);
  });

  it("#5/AC-4: a linha atrasada que o servidor já cobrou lê 'Atrasado (cobrado)' e não tem 'Cobrar'", () => {
    renderList({ filter: "late", rows: [{ ...late, alreadyCharged: true }] });
    expect(screen.getByText("Atrasado (cobrado)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cobrar" })).toBeNull();
  });

  it("#5/AC-1: a coluna Status desenha a variante de cada situação, e o documento citado a confirmar", () => {
    renderList({
      filter: "all",
      rows: [
        waiting,
        { ...late, id: "a", invoiceNumber: "1", status: "fulfilled" },
        { ...late, id: "b", invoiceNumber: "2", status: "partiallyFulfilled" },
        { ...late, id: "c", invoiceNumber: "3", status: "needsInformation" },
        { ...late, id: "d", invoiceNumber: "4", status: "refused" },
        toConfirm,
      ],
    });
    for (const text of ["Aguardando", "Atendeu", "Atendeu parcialmente", "Pediu informação", "Recusou", "Atendeu: ND 881"]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("(citada, falta confirmar)")).toBeTruthy();
  });

  it("#5/AC-2: atendeu com próximo passo responder ou cobrar diz 'Atendeu, falta responder' e 'Atendeu, falta cobrar', sem a nota de documento", () => {
    renderList({
      filter: "all",
      rows: [
        { ...late, id: "e", invoiceNumber: "5", status: "fulfilledToAnswer" },
        { ...late, id: "f", invoiceNumber: "6", status: "fulfilledToFollowUp" },
      ],
    });
    expect(screen.getByText("Atendeu, falta responder")).toBeTruthy();
    expect(screen.getByText("Atendeu, falta cobrar")).toBeTruthy();
    expect(screen.queryByText("(citada, falta confirmar)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cobrar" })).toBeNull();
  });

  it("#18: carregando mostra o aviso de carga e os chips sem contagem inventada", () => {
    renderList({ state: "loading", rows: [] });
    expect(screen.getByText("Carregando os pedidos ao fornecedor…")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Atrasados/ }).textContent).not.toMatch(/\d/);
    expect(screen.queryByRole("row")).toBeNull();
  });

  it("#18: erro mostra a mensagem do wireframe, sem lista parcial, e 'Tentar de novo' tenta de novo", () => {
    const { onRetry } = renderList({ state: "error", rows: [] });
    expect(screen.getByText("Não consegui carregar os pedidos ao fornecedor.")).toBeTruthy();
    expect(screen.queryByRole("row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("#18: vazio geral diz o que fazer e oferece ir à Fila de aprovação", () => {
    renderList({ state: "empty", rows: [] });
    expect(screen.getByText("Nenhum pedido ao fornecedor ainda.")).toBeTruthy();
    expect(screen.getByText(/depois que você emite e envia a nota de devolução/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ir para a Fila de aprovação" }));
    expect(navigate).toHaveBeenCalledWith("/pagar/fila"); // ADR-004
  });

  it("#5/AC-2: chip com 0 diz 'Nenhum pedido atrasado.' e 'Ver todos' limpa o filtro", () => {
    const { onShowAll } = renderList({ rows: [], counts: { waiting: 7, fulfilled: 12, needsYou: 3, late: 0 } });
    expect(screen.getByRole("radio", { name: /^Atrasados/ }).textContent).toMatch(/0/);
    expect(screen.getByText("Nenhum pedido atrasado.")).toBeTruthy();
    expect(screen.getByText("Nenhum fornecedor está devendo resposta.")).toBeTruthy();
    expect(screen.queryByRole("row", { name: /Nota/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ver todos" }));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it("#65/AC-1: a linha cuja leitura tem ordem escondida mostra o selo '⚠ Ordem escondida', com nome acessível; as outras não", () => {
    renderList({ rows: [{ ...late, hiddenOrder: true }, lateToo] });
    const rows = screen.getAllByRole("row").slice(1);
    const flagged = within(rows[0]!);
    expect(flagged.getByText("⚠ Ordem escondida")).toBeTruthy();
    expect(flagged.getByRole("img", { name: "Ordem escondida na resposta do fornecedor" })).toBeTruthy();
    expect(within(rows[1]!).queryByText("⚠ Ordem escondida")).toBeNull();
  });
});
