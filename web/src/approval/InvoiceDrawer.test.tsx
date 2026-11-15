import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvoiceDrawer } from "./InvoiceDrawer";

// #209 A gaveta única da nota: carregando, sem proposta, erro, pronta, e o que a tela põe acima da proposta.
const money = (cents: number) => ({ cents, text: `R$ ${cents / 100}` });
const proposal = {
  invoiceAccessKey: "k1", number: "77", supplierId: "F", store: "CD", issuedOn: "2026-11-10", total: money(1000), classification: "E3", level: "analista", line: 1,
  reason: "r", requiredApproverLevel: "analista", amountAtRisk: money(100), dockAction: { kind: "receber" }, state: "aguardando_aprovacao", canApprove: false, justification: "j",
  items: [], divergences: [], title: { state: "lancado", amount: money(1000), dueOn: "2026-11-30" }, approval: null, dossier: { status: "pending", reason: "x" },
};
const serve = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
const open = (children?: React.ReactNode) =>
  render(<InvoiceDrawer invoiceAccessKey="k1" title={(n) => `Nota ${n ?? "…"}`} onClose={() => {}}>{children}</InvoiceDrawer>);
afterEach(() => vi.unstubAllGlobals());

describe("#209 InvoiceDrawer", () => {
  it("carrega, mostra a proposta com o número no título e o conteúdo da tela acima dela", async () => {
    serve(200, proposal);
    open(<p>Conteúdo da tela</p>);
    expect(screen.getByText("Carregando a proposta…")).toBeTruthy();
    expect(await screen.findByText("Nota 77")).toBeTruthy();
    const extra = screen.getByText("Conteúdo da tela");
    const panel = document.querySelector(".pagar-proposal") as Node;
    expect(extra.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("nota sem proposta (404) diz que não tem, mantendo o conteúdo da tela", async () => {
    serve(404, { error: "not_found" });
    open(<p>Conteúdo da tela</p>);
    await waitFor(() => expect(screen.getByText("Esta nota não tem proposta de aprovação.")).toBeTruthy());
    expect(screen.getByText("Conteúdo da tela")).toBeTruthy();
  });
  it("falha do servidor mostra o erro de leitura", async () => {
    serve(500, { error: "x" });
    open();
    await waitFor(() => expect(screen.getByText("Não consegui ler esta proposta agora.")).toBeTruthy());
  });
});
