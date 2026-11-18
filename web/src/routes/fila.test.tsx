import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilaDeAprovacao from "./fila";

// #201 AC3: a coluna "Código" da fila mostra MATCH como traço e o código de exceção como é.

const money = (cents: number) => ({ cents, text: `R$ ${cents / 100}` });

const queueItem = (n: string, exceptionCode: string) => ({
  invoiceAccessKey: `key-${n}`,
  number: n,
  supplierId: "F12",
  store: "CD-01",
  issuedOn: "2026-11-10",
  total: money(100_000),
  classification: exceptionCode,
  exceptionCode,
  exceptionName: `Nome ${n}`,
  level: "analista",
  line: 1,
  reason: "x",
  requiredApproverLevel: "analista",
  amountAtRisk: money(1000),
  dockAction: { kind: "receber" },
  state: "aguardando_aprovacao",
  canApprove: true,
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

/** #201 AC3: o texto da célula "Código" de cada linha, na ordem das linhas do corpo da tabela. */
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

describe("#201 fila: coluna Código", () => {
  it("AC3: a fila mostra MATCH como traço e E3 como código", async () => {
    serve("/api/fila", {
      approver: { email: null, level: "analista" },
      items: [queueItem("1", "MATCH"), queueItem("2", "E3")],
    });
    render(<FilaDeAprovacao params={{}} />);
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(codeCells().sort()).toEqual(["E3", "—"]);
  });
});
