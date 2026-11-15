import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalPanel } from "./ProposalPanel";
import type { ProposalDetailDto } from "../api/approval";

// #134 A decisão pela ação no recebimento: Receber, Receber parcial e Recusar.

const KEY = "35261100000000000000550010000080001000080001";
const money = (cents: number) => ({ cents, text: `R$ ${(cents / 100).toFixed(2).replace(".", ",")}` });

const proposal = (dockAction: unknown, extra: Record<string, unknown> = {}) =>
  ({
    invoiceAccessKey: KEY,
    number: "80",
    supplierId: "F12",
    store: "CD-01",
    issuedOn: "2026-11-10",
    total: money(100_000),
    classification: "E4",
    level: "coordenacao",
    line: 2,
    reason: "Falta na contagem",
    requiredApproverLevel: "coordenacao",
    amountAtRisk: money(20_000),
    dockAction,
    state: "aguardando_aprovacao",
    canApprove: true,
    justification: "Faltou item",
    items: [
      { supplierCode: "A", sku: "SKU-1", description: "Arroz 5kg", quantity: { amount: 10, unit: "UN" }, unitPrice: money(1000), total: money(10_000) },
      { supplierCode: "B", sku: "SKU-2", description: "Feijão 1kg", quantity: { amount: 5, unit: "CX" }, unitPrice: money(2000), total: money(10_000) },
    ],
    divergences: [],
    title: { state: "lancado", amount: money(100_000), dueOn: "2026-11-30" },
    approval: null,
    dossier: { status: "pending", reason: "x" },
    ...extra,
  }) as unknown as ProposalDetailDto; // #134 a fixture é parcial: o DTO real traz campos que estes testes não leem

let calls: { path: string; body: unknown }[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ path: String(input), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({
        approval: { approver: "c", approverLevel: "coordenacao", dockAction: { kind: "receber_parcial" }, justification: "x", decidedOn: "2026-11-15" },
        title: { state: "na_lista_do_dia", amount: money(80_000) },
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("#134 decisão pela ação no recebimento", () => {
  it("AC-1: oferece Receber, Receber parcial e Recusar, com a proposta marcada, e sem o texto antigo", () => {
    render(<ProposalPanel proposal={proposal({ kind: "recusar" })} />);
    for (const name of [/^Receber(?! parcial)/, /^Receber parcial/, /^Recusar/]) expect(screen.getByRole("radio", { name })).toBeTruthy();
    expect(screen.getByText("Proposta do sistema")).toBeTruthy();
    expect(screen.queryByText(/Aprovar mantém/)).toBeNull();
    expect(screen.queryByText(/Aprovar:|Alterar para/)).toBeNull();
  });

  it("escolher a proposta aprova sem justificativa; escolher outra a exige (regra 8)", async () => {
    render(<ProposalPanel proposal={proposal({ kind: "recusar" })} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Receber(?! parcial)/ }));
    fireEvent.click(screen.getByRole("button", { name: /Registrar a decisão/ }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("radio", { name: /^Recusar/ }));
    fireEvent.click(screen.getByRole("button", { name: /Registrar a decisão/ }));
    await waitFor(() => expect(calls[0]?.path).toBe(`/api/propostas/${KEY}/aprovar`));
  });

  it("AC-2: receber parcial lista os itens, o que entra e o que fica segurado ou volta", () => {
    const p = proposal({ kind: "receber_parcial", lines: [{ sku: "SKU-1", quantity: { amount: 3, unit: "UN" }, disposition: "segurar" }] });
    render(<ProposalPanel proposal={p} />);
    expect(screen.getByText("Itens do recebimento parcial")).toBeTruthy();
    expect(screen.getByText("Arroz 5kg")).toBeTruthy();
    expect(screen.getByText("Entra 7 UN · Segura 3 UN")).toBeTruthy();
    expect(screen.getByText("Entra 5 CX")).toBeTruthy();
  });

  it("AC-3: alterar para receber parcial pede os itens e as quantidades, e eles viram a ação enviada", async () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" })} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Receber parcial/ }));
    fireEvent.change(document.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "Faltou arroz na doca" } });
    fireEvent.click(screen.getByRole("button", { name: /Registrar a decisão/ }));
    await screen.findByText(/informe ao menos um item/i);
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Quantidade a segurar ou devolver de Arroz 5kg"), { target: { value: "4" } });
    fireEvent.click(within(screen.getByRole("group", { name: "O que fazer com Arroz 5kg" })).getByRole("combobox"));
    fireEvent.click(screen.getByText("Devolver"));
    fireEvent.click(screen.getByRole("button", { name: /Registrar a decisão/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.path).toBe(`/api/propostas/${KEY}/alterar`);
    expect(calls[0]?.body).toEqual({
      dockAction: { kind: "receber_parcial", lines: [{ sku: "SKU-1", quantity: { amount: 4, unit: "UN" }, disposition: "devolver" }] },
      justification: "Faltou arroz na doca",
    });
  });

  it("AC-4: depois da contagem, os rótulos são Confirmar recebimento e Confirmar recebimento parcial", () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" })} afterCount />);
    expect(screen.getByRole("radio", { name: /^Confirmar recebimento(?! parcial)/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Confirmar recebimento parcial/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Recusar/ })).toBeTruthy();
  });

  it("#176/AC-1: proposta E1 com contagem usa os rótulos de depois da contagem, sem a prop afterCount", () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" }, { classification: "E1" })} />);
    expect(screen.getByRole("radio", { name: /^Confirmar recebimento(?! parcial)/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Confirmar recebimento parcial/ })).toBeTruthy();
  });

  it("#176/AC-1: proposta sem contagem (E4) continua com Receber, Receber parcial e Recusar", () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" })} />);
    expect(screen.getByRole("radio", { name: /^Receber(?! parcial)/ })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Confirmar recebimento/ })).toBeNull();
  });

  it("#176/AC-2: E4 com caixa mostra as duas unidades no receber parcial (12 CX = 48 UN)", () => {
    const items = [
      { supplierCode: "B", sku: "SKU-2", description: "Feijão 1kg", quantity: { amount: 12, unit: "CX" }, stockQuantity: { amount: 48, unit: "UN" }, unitPrice: money(2000), total: money(24_000) },
    ];
    render(
      <ProposalPanel
        proposal={proposal(
          { kind: "receber_parcial", lines: [{ sku: "SKU-2", quantity: { amount: 2, unit: "CX" }, disposition: "segurar" }] },
          { classification: "E4", items },
        )}
      />,
    );
    expect(screen.getByText(/Entra 10 CX \(40 UN\)/)).toBeTruthy();
    expect(screen.getByText(/Segura 2 CX \(8 UN\)/)).toBeTruthy();
  });

  it("#176/AC-2: na digitação do parcial, a quantidade da nota aparece com a de estoque", () => {
    const items = [
      { supplierCode: "B", sku: "SKU-2", description: "Feijão 1kg", quantity: { amount: 12, unit: "CX" }, stockQuantity: { amount: 48, unit: "UN" }, unitPrice: money(2000), total: money(24_000) },
    ];
    render(<ProposalPanel proposal={proposal({ kind: "receber" }, { classification: "E4", items })} />);
    expect(screen.getByText("Feijão 1kg (12 CX = 48 UN)")).toBeTruthy();
  });

  it("#176: a quantidade com vírgula (4,5) vale 4.5 e texto que não é número avisa em vez de sumir", async () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" })} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Receber parcial/ }));
    fireEvent.change(document.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "Faltou arroz na doca" } });
    fireEvent.change(screen.getByLabelText("Quantidade a segurar ou devolver de Arroz 5kg"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /Registrar a de/ }));
    await screen.findByText(/precisa ser um número/);
    fireEvent.change(screen.getByLabelText("Quantidade a segurar ou devolver de Arroz 5kg"), { target: { value: "4,5" } });
    fireEvent.click(screen.getByRole("button", { name: /Registrar a de/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ dockAction: { lines: [{ sku: "SKU-1", quantity: { amount: 4.5 } }] } });
  });
});
