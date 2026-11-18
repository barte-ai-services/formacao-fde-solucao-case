import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Select } from "barte-design-system";
import { RowTable } from "./RowTable";
import { InvoiceCell } from "./InvoiceCell";

// #209 AC-3 e AC-4: a linha da grid abre a nota; o que é controle dentro dela continua só controle.
type Row = { key: string; number: string };
const rows: Row[] = [{ key: "k1", number: "10" }, { key: "k2", number: "20" }];

function setup(onOpenRow = vi.fn(), onInner = vi.fn()) {
  render(
    <RowTable<Row>
      data={rows}
      rowKey={(r) => r.key}
      onOpenRow={(r) => onOpenRow(r.key)}
      rowLabel={(r) => `Abrir a nota ${r.number}`}
      columns={[
        { key: "nota", title: "Nota", dataIndex: "number", render: (_, r) => <InvoiceCell number={r.number} onOpen={() => onInner(r.key)} /> },
        { key: "valor", title: "Valor", dataIndex: "key", render: () => "R$ 1,00" },
        { key: "acao", title: "Ação", dataIndex: "key", render: () => <Select size="sm" value="a" onChange={() => {}} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} /> },
      ]}
    />,
  );
  return { onOpenRow, onInner };
}
const row = (n: string) => screen.getByRole("row", { name: `Abrir a nota ${n}` });

describe("#209 RowTable", () => {
  it("AC-3: a linha tem o rótulo, entra na ordem do teclado e abre pelo clique", () => {
    const { onOpenRow } = setup();
    expect(row("10").getAttribute("tabindex")).toBe("0");
    fireEvent.click(within(row("20")).getByText("R$ 1,00"));
    expect(onOpenRow).toHaveBeenCalledWith("k2");
  });

  it("AC-3: Enter e espaço na linha abrem; outras teclas não", () => {
    const { onOpenRow } = setup();
    fireEvent.keyDown(row("10"), { key: "Enter" });
    fireEvent.keyDown(row("10"), { key: " " });
    fireEvent.keyDown(row("10"), { key: "a" });
    expect(onOpenRow).toHaveBeenCalledTimes(2);
  });

  it("AC-4: o botão da NF faz o que faz e não abre a gaveta; nem o seletor da linha", () => {
    const { onOpenRow, onInner } = setup();
    fireEvent.click(within(row("10")).getByRole("button", { name: "NF 10" }));
    expect(onInner).toHaveBeenCalledWith("k1");
    fireEvent.click(within(row("10")).getByRole("combobox"));
    expect(onOpenRow).not.toHaveBeenCalled();
    // Enter no botão não conta como Enter da linha.
    fireEvent.keyDown(within(row("10")).getByRole("button", { name: "NF 10" }), { key: "Enter" });
    expect(onOpenRow).not.toHaveBeenCalled();
  });
});

describe("#209 RowTable: sem o que reordena as linhas", () => {
  it("não aceita coluna ordenável, e cada linha leva o rótulo da sua nota", () => {
    // @ts-expect-error a coluna ordenável fica de fora: a posição da linha é a chave do teclado e do rótulo
    const bad = <RowTable<Row> data={rows} rowKey={(r) => r.key} onOpenRow={() => {}} rowLabel={(r) => r.number} columns={[{ key: "n", title: "N", dataIndex: "number", sortable: true }]} />;
    expect(bad).toBeTruthy();
    setup();
    expect(row("10").textContent).toContain("10");
    expect(row("20").textContent).toContain("20");
  });
});

describe("#160 RowTable: linha inerte (esqueleto)", () => {
  const data = [...rows, { key: "sk", number: "…" }];
  const render3 = (onOpenRow = vi.fn()) => {
    render(
      <RowTable<Row>
        data={data}
        rowKey={(r) => r.key}
        rowInert={(r) => r.key === "sk"}
        onOpenRow={(r) => onOpenRow(r.key)}
        rowLabel={(r) => `Abrir a nota ${r.number}`}
        columns={[{ key: "nota", title: "Nota", dataIndex: "number", render: (_, r) => `NF ${r.number}` }]}
      />,
    );
    return onOpenRow;
  };

  it("#160/AC-1: a linha inerte não tem tabindex nem rótulo, é aria-hidden e não abre a gaveta", () => {
    const onOpenRow = render3();
    const trs = Array.from(document.querySelectorAll("tbody tr"));
    const inert = trs[2]!;
    expect(inert.getAttribute("tabindex")).toBeNull();
    expect(inert.getAttribute("aria-label")).toBeNull();
    expect(inert.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(inert);
    fireEvent.keyDown(inert, { key: "Enter" });
    expect(onOpenRow).not.toHaveBeenCalled();
  });

  it("#160/AC-1: as outras linhas seguem como na #209", () => {
    const onOpenRow = render3();
    fireEvent.click(row("10"));
    fireEvent.keyDown(row("20"), { key: "Enter" });
    expect(onOpenRow.mock.calls).toEqual([["k1"], ["k2"]]);
    expect(row("10").getAttribute("tabindex")).toBe("0");
  });
});
