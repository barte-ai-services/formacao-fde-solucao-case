import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilaDeAprovacao from "../src/routes/fila";
import ListaDoDia from "../src/routes/lista-do-dia";
import NotasDuplicadas from "../src/routes/duplicadas";
import ReturnNotes from "../src/routes/devolucoes";

// #211 AC-3: a coluna "Decidido por", com o selo certo, nas grids que sabem quem decidiu.
const money = (cents: number) => ({ cents, text: `R$ ${cents / 100}` });
const params = { params: {} };
function serve(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
}
afterEach(() => vi.unstubAllGlobals());

describe("#211 coluna Decidido por", () => {
  it("fila: o que espera mostra Aguardando pessoa", async () => {
    serve({
      approver: { email: null, level: "analista" },
      items: [{ invoiceAccessKey: "k", number: "1", supplierId: "F", store: "CD", issuedOn: "2026-11-10", total: money(1), classification: "E3", exceptionCode: "E3", exceptionName: "N", level: "analista", line: 1, reason: "x", requiredApproverLevel: "analista", amountAtRisk: money(1), dockAction: { kind: "receber" }, state: "aguardando_aprovacao", canApprove: true }],
    });
    render(<FilaDeAprovacao {...params} />);
    expect(await screen.findByText("Decidido por")).toBeTruthy();
    expect(screen.getByText("Aguardando pessoa")).toBeTruthy();
  });
  it("lista do dia: Regra com o selo azul e a pessoa pelo nome", async () => {
    const item = (n: string, approver: string) => ({ invoiceAccessKey: `k${n}`, number: n, supplierId: "F", amount: money(1), invoiceTotal: money(2), dueOn: "2026-11-15", exceptionCode: "E3", exceptionName: "N", dockAction: "receber", approver });
    serve({ day: "2026-11-15", total: money(2), items: [item("1", "regra"), item("2", "ana@jachegou.com")] });
    render(<ListaDoDia {...params} />);
    expect(await screen.findByText("⚙ Regra")).toBeTruthy();
    expect(screen.getByText("ana@jachegou.com")).toBeTruthy();
  });
  it("duplicadas: o sistema bloqueou", async () => {
    serve({ duplicates: [{ duplicate: { accessKey: "k", number: "9", supplierId: "F", issuedOn: "2026-11-10", totalCents: 1, total: "R$ 1" }, original: null, reason: "ordem_sem_saldo", titleState: "bloqueado", blockedAmountCents: 1, blockedAmount: "R$ 1" }], count: 1 });
    render(<NotasDuplicadas {...params} />);
    expect(await screen.findByText("⚙ Automático")).toBeTruthy();
  });
  it("duplicadas: título que não está bloqueado não leva o selo do sistema", async () => {
    serve({ duplicates: [{ duplicate: { accessKey: "k", number: "9", supplierId: "F", issuedOn: "2026-11-10", totalCents: 1, total: "R$ 1" }, original: null, reason: "titulo_lancado", titleState: "lancado", blockedAmountCents: 1, blockedAmount: "R$ 1" }], count: 1 });
    render(<NotasDuplicadas {...params} />);
    await screen.findByText("Decidido por");
    expect(screen.queryByText("⚙ Automático")).toBeNull();
  });
  it("devoluções: pendente aguarda; emitida mostra quem emitiu", async () => {
    const note = (id: number, extra: object) => ({ id, status: "pendente", invoiceAccessKey: `k${id}`, invoiceNumber: String(id), supplierId: "F", reason: "E3", lines: [], valueCents: 1, publishedAt: "2026-11-15T12:00:00Z", pendingSeconds: 60, emitted: null, cancelled: null, ...extra });
    serve({ notes: [note(1, {}), note(2, { status: "emitida", emitted: { number: "5", by: "Bia Lima", at: "2026-11-15T13:00:00Z" } })] });
    render(<ReturnNotes {...params} />);
    await waitFor(() => expect(screen.getByText("Aguardando pessoa")).toBeTruthy());
    expect(screen.getByText("Bia Lima")).toBeTruthy();
  });
});
