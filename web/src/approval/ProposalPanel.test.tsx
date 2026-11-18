import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalPanel } from "./ProposalPanel";
import type { ProposalDetailDto } from "../api/approval";
import type { AuditDto } from "../api/approval";
import type { SupplierRequestPort } from "./supplier-request-state";

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
    divergences: [{ classification: "E4", exceptionCode: "E4", exceptionName: "Unidade de medida", skus: ["SKU-1", "SKU-2"], evidence: [] }],
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

  it("AC-3: alterar para receber parcial já traz os itens preenchidos, e o que a pessoa ajusta vira a ação enviada", async () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" })} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Receber parcial/ }));
    fireEvent.change(document.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "Faltou arroz na doca" } });
    expect((screen.getByLabelText("Quantidade a segurar ou devolver de Arroz 5kg") as HTMLInputElement).value).toBe("10");
    fireEvent.change(screen.getByLabelText("Quantidade a segurar ou devolver de Arroz 5kg"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Quantidade a segurar ou devolver de Feijão 1kg"), { target: { value: "0" } });
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
    fireEvent.click(screen.getByRole("radio", { name: /^Receber parcial/ }));
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
    fireEvent.change(screen.getByLabelText("Quantidade a segurar ou devolver de Feijão 1kg"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /Registrar a de/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ dockAction: { lines: [{ sku: "SKU-1", quantity: { amount: 4.5 } }] } });
  });

  it("#134: nota sem divergência (MATCH) não mostra o bloco de itens a segurar ou devolver", () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" }, { classification: "MATCH", divergences: [] })} />);
    expect(screen.queryByText("Receber parcial: itens a segurar ou devolver")).toBeNull();
    // Sem item divergente o parcial não tem o que informar: a opção também some, não vira beco sem saída.
    expect(screen.queryByRole("radio", { name: /^Receber parcial/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /^Receber(?! parcial)/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Recusar/ })).toBeTruthy();
  });

});

describe("#203 a decisão na gaveta: opções, itens do receber parcial, justificativa", () => {
  const LIST = "Itens a segurar ou devolver";
  const partialRadio = () => screen.getByRole("radio", { name: /^(Receber|Confirmar recebimento) parcial/ });

  it("AC-1: com Receber ou Recusar marcado (ou nada), a lista dos itens não aparece", () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" })} />);
    expect(screen.queryByText(LIST)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /^Recusar/ }));
    expect(screen.queryByText(LIST)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /^Receber(?! parcial)/ }));
    expect(screen.queryByText(LIST)).toBeNull();
    expect(screen.queryByText(/Vale só se você escolher/)).toBeNull();
  });

  it("AC-2: com Receber parcial, a lista fica entre as opções e a justificativa, pré-preenchida pela divergência", () => {
    const e3 = { classification: "E3", exceptionCode: "E3", exceptionName: "Quantidade menor", skus: ["SKU-1"], evidence: [{ source: "wms", reference: "r", description: "Contado 7 UN de 10 UN: Arroz 5kg" }] };
    render(<ProposalPanel proposal={proposal({ kind: "receber" }, { classification: "E3", divergences: [e3] })} />);
    fireEvent.click(partialRadio());
    const list = screen.getByText(LIST);
    const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(screen.getByRole("radiogroup"), list)).toBe(true);
    expect(before(list, document.querySelector("textarea") as Node)).toBe(true);
    expect((screen.getByLabelText("Quantidade a segurar ou devolver de Arroz 5kg") as HTMLInputElement).value).toBe("3");
    expect(screen.getByText("Devolver")).toBeTruthy();
    // O item sem divergência continua na lista, vazio.
    expect((screen.getByLabelText("Quantidade a segurar ou devolver de Feijão 1kg") as HTMLInputElement).value).toBe("");
  });

  it("AC-3: trocar de opção e voltar mantém o digitado; registrar com outra opção não envia linhas", async () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" })} />);
    fireEvent.click(partialRadio());
    fireEvent.change(screen.getByLabelText("Quantidade a segurar ou devolver de Arroz 5kg"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Recusar/ }));
    expect(screen.queryByText(LIST)).toBeNull();
    fireEvent.click(partialRadio());
    expect((screen.getByLabelText("Quantidade a segurar ou devolver de Arroz 5kg") as HTMLInputElement).value).toBe("6");
    fireEvent.click(screen.getByRole("radio", { name: /^Recusar/ }));
    fireEvent.change(document.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "Recusa por divergência" } });
    fireEvent.click(screen.getByRole("button", { name: /Registrar a decisão/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ dockAction: { kind: "recusar" }, justification: "Recusa por divergência" });
  });

  it("AC-4: Receber parcial sem quantidade maior que zero desabilita o Registrar e diz por quê", () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" })} />);
    fireEvent.click(partialRadio());
    const submit = screen.getByRole("button", { name: /Registrar a decisão/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    for (const n of ["Arroz 5kg", "Feijão 1kg"]) fireEvent.change(screen.getByLabelText(`Quantidade a segurar ou devolver de ${n}`), { target: { value: "0" } });
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/informe ao menos um item/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Quantidade a segurar ou devolver de Arroz 5kg"), { target: { value: "2" } });
    expect(submit.disabled).toBe(false);
  });

  it("nota sem divergência em item (MATCH) não mostra o parcial", () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" }, { classification: "MATCH", divergences: [] })} />);
    expect(screen.queryByRole("radio", { name: /^Receber parcial/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /^Receber(?! parcial)/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Recusar/ })).toBeTruthy();
  });
});

describe("#209 AC-5: nota já decidida abre só para leitura", () => {
  it("mostra a decisão registrada, sem as opções nem o Registrar", () => {
    const approval = { approver: "c", approverLevel: "coordenacao", dockAction: { kind: "receber" }, justification: "ok", decidedOn: "2026-11-15" };
    render(<ProposalPanel proposal={proposal({ kind: "receber" }, { state: "na_lista_do_dia", approval })} />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: /Registrar/ })).toBeNull();
    expect(screen.getByText(/decis/i)).toBeTruthy();
  });
});

// #231 O bloco "Agente auditor" na gaveta: onde fica, e que sem auditoria informada o painel segue como antes.
const AUDITED: AuditDto = {
  status: "auditada",
  classification: "E2",
  dockAction: { kind: "receber" },
  routing: "coordenacao",
  justification: "A ordem de compra confirma a quantidade da nota.\nO preço bate com o pedido.",
  amountAtRisk: null,
  model: "claude-exemplo",
  auditedAt: "2026-11-15T17:32:00Z",
  agreement: { agrees: false, differs: ["classification"] },
  raisedLevel: null,
  injectionFlag: null,
  refusals: [],
};
const follows = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("#231 bloco Agente auditor no painel", () => {
  it("#231/AC-2 auditada: o bloco vem depois das Evidências e antes do Dossiê do Claude", () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" }, { audit: AUDITED })} />);
    const block = screen.getByRole("region", { name: "Agente auditor" });
    expect(screen.getByText("Discorda: classifica como E2, não E4")).toBeTruthy();
    expect(follows(screen.getByText("Evidência por divergência"), block)).toBe(true);
    expect(follows(block, screen.getByText("Dossiê do Claude"))).toBe(true);
  });

  it("#231/AC-2 com os itens do receber parcial, o bloco vem depois deles", () => {
    const p = proposal({ kind: "receber_parcial", lines: [{ sku: "SKU-1", quantity: { amount: 3, unit: "UN" }, disposition: "segurar" }] }, { audit: AUDITED });
    render(<ProposalPanel proposal={p} />);
    expect(follows(screen.getByText("Itens do recebimento parcial"), screen.getByRole("region", { name: "Agente auditor" }))).toBe(true);
  });

  it("#231/AC-5 não auditada: o bloco diz o motivo", () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" }, { audit: { status: "nao_auditada", reason: "erro_de_tool", refusals: [] } })} />);
    expect(screen.getByText("Não auditada")).toBeTruthy();
    expect(screen.getByText("Uma ferramenta falhou durante a auditoria.")).toBeTruthy();
  });

  it("#231/AC-5 auditoria nula: o bloco diz que está pendente", () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" }, { audit: null })} />);
    expect(screen.getByText("Auditoria pendente. Decida pelas evidências da conferência.")).toBeTruthy();
  });

  it("#231 sem o campo audit na proposta, o bloco não aparece e o resto do painel segue igual", () => {
    render(<ProposalPanel proposal={proposal({ kind: "receber" })} />);
    expect(screen.queryByText("Agente auditor")).toBeNull();
    expect(screen.getByText("Dossiê do Claude")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Recusar/ })).toBeTruthy();
  });
});

describe("#156 pedido ao fornecedor na gaveta da proposta decidida", () => {
  const approval = { approver: "c", approverLevel: "coordenacao", dockAction: { kind: "receber" }, justification: "ok", decidedOn: "2026-11-15" };
  const decided = () => proposal({ kind: "receber" }, { state: "na_lista_do_dia", approval });
  const email = { to: "fiscal@higienetotal.test", dueOn: "2026-11-18", subject: "NF 80 · devolução", body: "Texto do e-mail", template: "Texto do e-mail" };
  const port = (load: SupplierRequestPort["load"]): SupplierRequestPort => ({
    load,
    send: vi.fn(),
    resend: vi.fn(),
    discard: vi.fn(),
    redo: vi.fn(),
    saveTemplate: vi.fn(),
  });

  it("#156: com pedido, o bloco vem logo depois da Decisão registrada", async () => {
    render(<ProposalPanel proposal={decided()} supplierRequest={{ port: port(async () => ({ status: "draft", email })), viewer: "ana@jachegou.test" }} />);
    const block = await screen.findByRole("region", { name: "Pedido ao fornecedor" });
    const alert = screen.getByText("Decisão registrada");
    expect(alert.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("#156: sem pedido na nota, a gaveta fica como era, sem o bloco", async () => {
    const load = vi.fn(async () => null);
    render(<ProposalPanel proposal={decided()} supplierRequest={{ port: port(load), viewer: "ana@jachegou.test" }} />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Pedido ao fornecedor" })).toBeNull();
    expect(screen.getByText("Decisão registrada")).toBeTruthy();
  });

  it("#156: sem a fonte do pedido (gaveta de antes da #156), nada é buscado nem desenhado", () => {
    render(<ProposalPanel proposal={decided()} />);
    expect(screen.queryByRole("region", { name: "Pedido ao fornecedor" })).toBeNull();
  });

  it("#156: antes da decisão, o pedido não é buscado", () => {
    const load = vi.fn(async () => null);
    render(<ProposalPanel proposal={proposal({ kind: "receber" })} supplierRequest={{ port: port(load), viewer: "ana@jachegou.test" }} />);
    expect(load).not.toHaveBeenCalled();
  });
});
