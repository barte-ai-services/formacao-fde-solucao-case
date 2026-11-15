import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposalDetailDto } from "../src/api/approval";
import type { ProposalDossierDto } from "../src/api/contract";
import { ProposalPanel } from "../src/approval/ProposalPanel";

// #130 O pedido do dossiê na gaveta: o botão, as respostas do Worker (202, 409, 429) e a leitura de novo.

const KEY = "35261100000000000000550010000080001000080001";
const money = (cents: number) => ({ cents, text: `R$ ${(cents / 100).toFixed(2)}` });

const proposal = (dossier: ProposalDossierDto) =>
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
    reason: "Unidade",
    requiredApproverLevel: "coordenacao",
    amountAtRisk: money(0),
    dockAction: { kind: "receber" },
    state: "aguardando_aprovacao",
    canApprove: false,
    justification: "x",
    items: [],
    divergences: [],
    title: { state: "lancado", amount: money(100_000), dueOn: "2026-11-30" },
    approval: null,
    dossier,
  }) as unknown as ProposalDetailDto; // #130 a fixture é parcial: estes testes só leem o dossiê

const PENDING: ProposalDossierDto = { status: "unavailable", reason: "pending", notice: "", generatedAt: null };
const READY: ProposalDossierDto = {
  status: "ready",
  summary: "A nota cobra 72 UN; a ordem pediu 6 CX.",
  divergences: [],
  supplierHistory: "14 notas lançadas.",
  generatedAt: "2026-11-15T13:15:00Z",
  model: "claude-exemplo",
};

type Reply = { status: number; body: unknown };
let replies: Record<string, Reply[]> = {};
let calls: { method: string; path: string }[] = [];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  replies = {};
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = String(input);
      calls.push({ method, path });
      const queue = replies[`${method} ${path}`] ?? [];
      const reply = queue.length > 1 ? queue.shift()! : queue[0];
      if (!reply) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(reply.body, { status: reply.status });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const POST = `POST /api/propostas/${KEY}/dossie`;
const GET = `GET /api/propostas/${KEY}`;
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("#130 pedir o dossiê na gaveta", () => {
  it("#130 AC-2/AC-3 202 vira Gerando e a resposta aparece sozinha quando fica pronta", async () => {
    replies[POST] = [{ status: 202, body: { status: "generating", trigger: "on_demand", requested_by: "ana@exemplo.com", requested_at: "2026-11-15T13:14:00Z" } }];
    replies[GET] = [
      { status: 200, body: proposal({ status: "generating", trigger: "on_demand", requestedBy: "ana@exemplo.com", requestedAt: "2026-11-15T13:14:00Z" }) },
      { status: 200, body: proposal(READY) },
    ];
    render(<ProposalPanel proposal={proposal(PENDING)} />);
    fireEvent.click(screen.getByRole("button", { name: "✦ Pedir ao Claude" }));
    await flush();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(screen.getByText("✦ O Claude está lendo a nota, a ordem e o cadastro…")).toBeTruthy();
    expect(screen.getByText("Pedido por você às 10h14")).toBeTruthy();

    await wait(3_000);
    expect(screen.getByText("✦ O Claude está lendo a nota, a ordem e o cadastro…")).toBeTruthy();
    await wait(3_000);
    expect(screen.getByText(READY.status === "ready" ? READY.summary : "")).toBeTruthy();
    const gets = calls.filter((c) => c.method === "GET").length;
    await wait(10_000);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(gets); // #130 pronto: para de ler
  });

  it("#130 409: o Claude já está escrevendo, e o bloco fica em Gerando", async () => {
    replies[POST] = [{ status: 409, body: { error: "em_andamento" } }];
    render(<ProposalPanel proposal={proposal({ status: "unavailable", reason: "timeout", notice: "", generatedAt: null })} />);
    fireEvent.click(screen.getByRole("button", { name: "↻ Tentar de novo" }));
    await flush();
    expect(screen.getByText("O Claude já está escrevendo este dossiê.")).toBeTruthy();
    expect(screen.getByText("✦ O Claude está lendo a nota, a ordem e o cadastro…")).toBeTruthy();
  });

  it("#130 429: o aviso do limite, e o bloco continua como estava", async () => {
    replies[POST] = [{ status: 429, body: { error: "limite" } }];
    render(<ProposalPanel proposal={proposal(PENDING)} />);
    fireEvent.click(screen.getByRole("button", { name: "✦ Pedir ao Claude" }));
    await flush();
    expect(screen.getByText("Muitos pedidos para esta proposta. Tente de novo em alguns minutos.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "✦ Pedir ao Claude" })).toBeTruthy();
    await wait(10_000);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  it("#130 AC-3 a gaveta que abre em Gerando lê a proposta de novo e para ao fechar", async () => {
    replies[GET] = [{ status: 200, body: proposal({ status: "generating", trigger: "on_demand", requestedBy: "a", requestedAt: "2026-11-15T13:14:00Z" }) }];
    const { unmount } = render(
      <ProposalPanel proposal={proposal({ status: "generating", trigger: "on_demand", requestedBy: "a", requestedAt: "2026-11-15T13:14:00Z" })} />,
    );
    await wait(9_000);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(3);
    unmount();
    await wait(9_000);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(3);
  });

  it("#130 AC-4 Gerar de novo mantém o dossiê anterior na tela, com o aviso, até o novo ficar pronto", async () => {
    replies[POST] = [{ status: 202, body: { status: "generating", trigger: "on_demand", requested_by: "a", requested_at: "2026-11-15T14:00:00.000Z" } }];
    const NEWER = { ...READY, summary: "Dossiê novo.", generatedAt: "2026-11-15T14:00:10.123456+00:00" } as ProposalDossierDto;
    replies[GET] = [
      { status: 200, body: proposal({ status: "generating", trigger: "on_demand", requestedBy: "a", requestedAt: "2026-11-15T14:00:00.000Z" }) },
      { status: 200, body: proposal(NEWER) },
    ];
    render(<ProposalPanel proposal={proposal(READY)} />);
    fireEvent.click(screen.getByRole("button", { name: "↻ Gerar de novo" }));
    await flush();
    expect(screen.getByText("A nota cobra 72 UN; a ordem pediu 6 CX.")).toBeTruthy();
    expect(screen.getByText(/escrevendo uma versão nova/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "↻ Gerar de novo" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("✦ O Claude está lendo a nota, a ordem e o cadastro…")).toBeNull();
    await wait(3_000);
    expect(screen.getByText("A nota cobra 72 UN; a ordem pediu 6 CX.")).toBeTruthy();
    await wait(3_000);
    expect(screen.getByText("Dossiê novo.")).toBeTruthy();
  });

  it("#130 AC-4 a versão nova falhou (o pronto voltou mais velho que o pedido): avisa na hora e mantém o anterior", async () => {
    replies[POST] = [{ status: 202, body: { status: "generating", trigger: "on_demand", requested_by: "a", requested_at: "2026-11-15T14:00:00.000Z" } }];
    replies[GET] = [{ status: 200, body: proposal(READY) }];
    render(<ProposalPanel proposal={proposal(READY)} />);
    fireEvent.click(screen.getByRole("button", { name: "↻ Gerar de novo" }));
    await flush();
    await wait(3_000);
    expect(screen.getByText("O Claude não conseguiu escrever a versão nova. Esta continua valendo.")).toBeTruthy();
    expect(screen.getByText("A nota cobra 72 UN; a ordem pediu 6 CX.")).toBeTruthy();
    const gets = calls.filter((c) => c.method === "GET").length;
    await wait(10_000);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(gets);
  });

  it("#130 a releitura para no teto de 90 s mesmo com a API ainda em generating", async () => {
    const gen = { status: "generating", trigger: "event", requestedBy: "claude", requestedAt: "2026-11-15T13:14:00Z" } as ProposalDossierDto;
    replies[GET] = [{ status: 200, body: proposal(gen) }];
    render(<ProposalPanel proposal={proposal(gen)} />);
    await wait(120_000);
    const gets = calls.filter((c) => c.method === "GET").length;
    expect(gets).toBeLessThanOrEqual(30);
    await wait(30_000);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(gets);
  });

  it("#130 no teto, com o Claude ainda escrevendo, avisa e não volta calada para Pedir ao Claude", async () => {
    const gen = { status: "generating", trigger: "on_demand", requestedBy: "a", requestedAt: "2026-11-15T13:14:00Z" } as ProposalDossierDto;
    replies[GET] = [{ status: 200, body: proposal(gen) }];
    render(<ProposalPanel proposal={proposal(gen)} />);
    await wait(120_000);
    expect(screen.getByText("O Claude ainda está escrevendo; tente de novo em alguns minutos.")).toBeTruthy();
    expect(screen.getByText("✦ O Claude está lendo a nota, a ordem e o cadastro…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "✦ Pedir ao Claude" })).toBeNull();
  });

  it("#130 duplo clique manda um pedido só, e o Gerando guarda quem pediu e quando", async () => {
    replies[POST] = [{ status: 202, body: { status: "generating", trigger: "on_demand", requested_by: "a", requested_at: "2026-11-15T13:14:00Z" } }];
    render(<ProposalPanel proposal={proposal(PENDING)} />);
    const button = screen.getByRole("button", { name: "✦ Pedir ao Claude" });
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(screen.getByText("Pedido por você às 10h14")).toBeTruthy();
  });
});
