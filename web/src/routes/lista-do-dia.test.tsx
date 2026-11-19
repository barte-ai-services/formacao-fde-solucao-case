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
  approvedBy: "rule",
});

function serve(path: string, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      // #160 A lista do dia chega em blocos: o primeiro pedido leva `limite`, sem cursor.
      expect(String(input)).toBe(`${path}?limite=30`);
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

describe("#201 lista do dia: coluna Código", () => {
  it("AC3: a lista do dia mostra MATCH como traço e E3 como código", async () => {
    serve("/api/hoje", { day: "2026-11-15", items: [todayItem("1", "MATCH"), todayItem("2", "E3")], nextCursor: null, total: 2, aggregates: { toPay: money(2000), approvedByRule: 2 } });
    render(<ListaDoDia params={{}} />);
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(codeCells().sort()).toEqual(["E3", "—"]);
  });
});

describe("#160 lista do dia: quem aprovou", () => {
  /** #160 A coluna lê `approvedBy` da API: o motor tem o seu selo e não é tratado como pessoa (a tela antes só distinguia a regra do resto). */
  it("#160/AC-4: o motor aparece como motor, a regra como regra e a pessoa pelo nome", async () => {
    const decided = (n: string, approvedBy: "rule" | "engine" | "person", approver: string) => ({ ...todayItem(n, "E3"), approver, approvedBy });
    serve("/api/hoje", {
      day: "2026-11-15",
      items: [decided("1", "rule", "regra"), decided("2", "engine", "motor-de-aprovacao"), decided("3", "person", "ana@jachegou.test")],
      nextCursor: null,
      total: 3,
      aggregates: { toPay: money(3000), approvedByRule: 1 },
    });
    render(<ListaDoDia params={{}} />);
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    const row = (n: string) => screen.getByText(`NF ${n}`).closest("tr")!;
    expect(within(row("1")).getByText("⚙ Regra")).toBeTruthy();
    expect(within(row("2")).getByText("Motor")).toBeTruthy();
    expect(within(row("2")).queryByText("motor-de-aprovacao")).toBeNull();
    expect(within(row("3")).getByText("ana@jachegou.test")).toBeTruthy();
  });
});
