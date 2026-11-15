import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ValorBarrado, { type BarredAmountDto, reaisCurto } from "../src/routes/valor-barrado";

/**
 * Novembro com duas decididas que barram (E6 e E1) e duas aguardando (E6 e E2).
 * Barrado R$ 120 mil; aguardando R$ 37 mil; os dois juntos R$ 157 mil.
 */
const NOVEMBRO: BarredAmountDto = {
  month: "2026-11",
  baselineCents: 54_300_000,
  barred: {
    totalCents: 12_000_000,
    byException: [
      { classification: "E6", cents: 9_000_000, count: 2 },
      { classification: "E1", cents: 3_000_000, count: 1 },
    ],
  },
  ifApprovedAsProposed: {
    totalCents: 3_700_000,
    byException: [
      { classification: "E6", cents: 2_500_000, count: 1 },
      { classification: "E2", cents: 1_200_000, count: 1 },
    ],
  },
  daily: [
    { day: "2026-11-03", barredCumulativeCents: 3_000_000, proposedCumulativeCents: 1_200_000 },
    { day: "2026-11-10", barredCumulativeCents: 12_000_000, proposedCumulativeCents: 3_700_000 },
  ],
};

const VAZIO: BarredAmountDto = {
  month: "2026-11",
  baselineCents: 54_300_000,
  barred: { totalCents: 0, byException: [] },
  ifApprovedAsProposed: { totalCents: 0, byException: [] },
  daily: [],
};

function respondWith(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPanel() {
  return render(<ValorBarrado params={{}} />);
}

/** O cartão do `Stat` cuja legenda é `caption`. */
async function statCard(caption: string): Promise<HTMLElement> {
  const label = await screen.findByText(caption);
  let card: HTMLElement | null = label;
  while (card && !card.textContent?.includes("R$") && !card.textContent?.includes("%")) card = card.parentElement;
  if (!card) throw new Error(`sem cartão para ${caption}`);
  return card;
}

afterEach(() => vi.unstubAllGlobals());

describe("#71 painel do valor barrado no mês", () => {
  it("pede o endpoint do painel", async () => {
    const fetchMock = respondWith(200, NOVEMBRO);
    renderPanel();
    await screen.findByText("Barrado em novembro");
    expect(fetchMock).toHaveBeenCalledWith("/api/valor-barrado", expect.objectContaining({ method: "GET" }));
  });

  it("#71/AC-1 o ranking mostra cada exceção com o valor, barrado e aguardando somados", async () => {
    respondWith(200, NOVEMBRO);
    renderPanel();
    const title = await screen.findByRole("heading", { name: "Valor em risco por tipo de divergência" });
    const ranking = title.closest("section") ?? title.parentElement!.parentElement!.parentElement!;
    const e6 = await within(ranking).findByText("E6 · Duplicidade");
    expect(e6).toBeTruthy();
    expect(within(ranking).getByText("E1 · Falta física")).toBeTruthy();
    expect(within(ranking).getByText("E2 · Item trocado")).toBeTruthy();
    expect(within(ranking).getByText("R$ 115 mil")).toBeTruthy();
    expect(within(ranking).getByText("R$ 30 mil")).toBeTruthy();
    expect(within(ranking).getByText("R$ 12 mil")).toBeTruthy();
    expect(within(ranking).getByText("3 notas")).toBeTruthy();
  });

  it("#71/AC-2 a linha de base de R$ 543 mil aparece ao lado", async () => {
    respondWith(200, NOVEMBRO);
    renderPanel();
    expect(await screen.findByText("O mês contra os R$ 543 mil")).toBeTruthy();
    const contra = await statCard("Contra o pagar errado");
    expect(within(contra).getByText("22%")).toBeTruthy();
    expect(within(contra).getByText("de R$ 543 mil por mês; 29% com tudo aprovado")).toBeTruthy();
  });

  it("#71/AC-3 o Barrado é só o decidido, sem somar o aguardando aprovação", async () => {
    respondWith(200, NOVEMBRO);
    renderPanel();
    const barrado = await statCard("Barrado em novembro");
    expect(within(barrado).getByText("R$ 120 mil")).toBeTruthy();
    expect(within(barrado).queryByText("R$ 157 mil")).toBeNull();
    const emRisco = await statCard("Ainda em risco");
    expect(within(emRisco).getByText("R$ 37 mil")).toBeTruthy();
  });

  it("#71/AC-4 o total exibido bate com a soma das exceções da resposta", async () => {
    respondWith(200, NOVEMBRO);
    renderPanel();
    const somaBarrado = NOVEMBRO.barred.byException.reduce((s, e) => s + e.cents, 0);
    const somaAguardando = NOVEMBRO.ifApprovedAsProposed.byException.reduce((s, e) => s + e.cents, 0);
    expect(somaBarrado).toBe(NOVEMBRO.barred.totalCents);
    const barrado = await statCard("Barrado em novembro");
    expect(within(barrado).getByText(reaisCurto(somaBarrado))).toBeTruthy();
    const emRisco = await statCard("Ainda em risco");
    expect(within(emRisco).getByText(reaisCurto(somaAguardando))).toBeTruthy();
    expect(screen.getByText(`${reaisCurto(somaBarrado + somaAguardando)} de R$ 543 mil`)).toBeTruthy();
  });

  it("sem nada barrado nem aguardando, mostra o estado vazio", async () => {
    respondWith(200, VAZIO);
    renderPanel();
    expect(await screen.findByText(/Nada barrado neste mês ainda/)).toBeTruthy();
  });

  it("a API em 502 mostra a casca de erro com o tentar de novo", async () => {
    respondWith(502, { error: "upstream" });
    renderPanel();
    expect(await screen.findByText("Não consegui somar o valor barrado agora")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });
});

describe("#71 dinheiro em centavos inteiros", () => {
  it("reaisCurto arredonda em mil a partir de centavos e mostra por extenso abaixo de R$ 1.000", () => {
    expect(reaisCurto(54_300_000)).toBe("R$ 543 mil");
    expect(reaisCurto(99_999).replace(/\s/g, " ")).toBe("R$ 999,99");
  });
});
