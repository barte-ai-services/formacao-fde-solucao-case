import { CHECKS, Invoice, Money, Quantity } from "@domain";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DivergenceDto } from "../src/api/contract";
import { EvidenceView } from "../src/evidence/EvidenceView";
import { linkedPayment } from "../src/evidence/e7";
import { clearEvidenceRegistry, registerEvidence, evidenceComponentFor } from "../src/evidence/registry";

// #64 / #33 AC-5: a tela mostra o pagamento vinculado como evidência do E7.
// #64: a descrição é a que o checkPagoForaDoFluxo grava para o PG-5301 da base do kit.
const E7: DivergenceDto = {
  classification: "E7",
  exceptionCode: "E7",
  exceptionName: "Pago fora do fluxo",
  skus: [],
  evidence: [
    {
      source: "banco",
      reference: "PG-5301",
      description:
        "Pagamento PG-5301 de R$ 3.430,00 em 2026-11-02, por boleto avulso (compra emergencial da loja, fora do fluxo), sem título no contas a pagar",
    },
  ],
};

const registered = evidenceComponentFor("E7");
afterEach(() => {
  clearEvidenceRegistry();
  if (registered) registerEvidence("E7", registered);
});

describe("#33/AC-5 evidência do E7: o pagamento vinculado", () => {
  it("AC-5: lê o pagamento da evidência do banco", () => {
    expect(linkedPayment(E7.evidence)).toEqual({
      id: "PG-5301",
      amount: "R$ 3.430,00",
      paidOn: "2026-11-02",
      method: "boleto avulso",
      origin: "compra emergencial da loja, fora do fluxo",
    });
  });

  it("AC-5: mostra o pagamento, o valor, a data, a forma e a origem, e que pagaria duas vezes", () => {
    render(<EvidenceView divergence={E7} />);
    expect(screen.getByText("Pago fora do fluxo")).toBeTruthy();
    expect(screen.getByText("PG-5301")).toBeTruthy();
    expect(screen.getAllByText("R$ 3.430,00").length).toBeGreaterThan(0);
    expect(screen.getByText("02/11/2026")).toBeTruthy();
    expect(screen.getByText("boleto avulso")).toBeTruthy();
    expect(screen.getByText("compra emergencial da loja, fora do fluxo")).toBeTruthy();
    expect(screen.getByText(/pagaria duas vezes/)).toBeTruthy();
  });

  it("AC-5: evidência fora do formato cai no genérico, sem quebrar", () => {
    const odd: DivergenceDto = { ...E7, evidence: [{ source: "banco", reference: "PG-9", description: "outro texto" }] };
    expect(linkedPayment(odd.evidence)).toBeNull();
    render(<EvidenceView divergence={odd} />);
    expect(screen.getByText("PG-9")).toBeTruthy();
    expect(screen.getByText(/outro texto/)).toBeTruthy();
  });

  it("AC-5: sem evidência do banco, também cai no genérico", () => {
    render(<EvidenceView divergence={{ ...E7, evidence: [] }} />);
    expect(screen.getByText("Nenhuma evidência veio com esta divergência.")).toBeTruthy();
  });
});

// #64: contrato com o domínio. A descrição vem da verificação E7 de verdade (CHECKS), e não de um texto
// #64: escrito à mão; se o domínio mudar o formato, este teste quebra antes de a tela cair no genérico.
describe("#33/AC-5 contrato com o domínio do E7", () => {
  it("AC-5: a evidência que o checkPagoForaDoFluxo grava para o PG-5301 é lida pela tela", () => {
    const invoice = Invoice.receive({
      accessKey: "35261100000000000000550010000743741074374841",
      number: "74374",
      series: "1",
      supplierId: "F09",
      store: "LJ-025",
      issuedOn: "2026-11-09",
      purchaseOrderRef: null,
      entryChannel: "sefaz",
      items: [
        {
          supplierCode: "X1",
          sku: null,
          description: "Compra emergencial",
          quantity: Quantity.of(1, "UN"),
          unitPrice: Money.ofCents(343000),
          total: Money.ofCents(343000),
        },
      ],
      total: Money.ofCents(343000),
    });
    const payment = {
      id: "PG-5301",
      supplierId: "F09",
      store: "LJ-025",
      paidOn: "2026-11-02",
      amount: Money.ofCents(343000),
      method: "boleto avulso",
      origin: "compra emergencial da loja, fora do fluxo",
      invoiceAccessKey: null,
    };
    const ctx = { purchaseOrders: [], suppliers: [], products: [], postedInvoices: [], payments: [payment], receipts: [], capturedInvoices: [] };
    const [divergence] = CHECKS.find((c) => c.id === "E7")!.run(invoice, ctx);
    expect(linkedPayment([...divergence!.evidence])).toEqual(linkedPayment(E7.evidence));
  });
});
