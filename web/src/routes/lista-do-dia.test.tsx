import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ListaDoDia from "./lista-do-dia";

// #201 AC3: a coluna "Código" da lista do dia mostra MATCH como traço e o código de exceção como é.

const money = (cents: number) => ({ cents, text: `R$ ${cents / 100}` });

const todayItem = (n: string, exceptionCode: string) => ({
  invoiceAccessKey: `key-${n}`,
  number: n,
  supplierId: "F12",
  amount: money(1000),
  invoiceTotal: money(100_000),
  dueOn: "2026-11-15",
  exceptionCode,
  exceptionName: `Nome ${n}`,
  dockAction: "receber",
  approver: "regra",
});

function serve(path: string, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(path);
      return Response.json(body);
    }),
  );
}

/** O texto da célula "Código" de cada linha, na ordem das linhas do corpo da tabela. */
function codeCells(): string[] {
  const table = screen.getByRole("table");
  const head = within(table).getAllByRole("columnheader").map((h) => h.textContent);
  const col = head.findIndex((t) => t === "Código");
  expect(col).toBeGreaterThanOrEqual(0);
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[col]!.textContent ?? "");
}

afterEach(() => vi.unstubAllGlobals());

describe("#201 lista do dia: coluna Código", () => {
  it("AC3: a lista do dia mostra MATCH como traço e E3 como código", async () => {
    serve("/api/hoje", { day: "2026-11-15", total: { cents: 2000 }, items: [todayItem("1", "MATCH"), todayItem("2", "E3")] });
    render(<ListaDoDia params={{}} />);
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(codeCells().sort()).toEqual(["E3", "—"]);
  });
});
