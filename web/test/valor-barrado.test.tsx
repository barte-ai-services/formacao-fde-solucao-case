import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BarredAmountRoute, { type BarredAmountDto, formatBrlShort } from "../src/routes/valor-barrado";

// #71: novembro com duas decididas que barram (E6 e E1) e duas aguardando (E6 e E2).
// #71: barrado R$ 120 mil; aguardando R$ 37 mil; os dois juntos R$ 157 mil.
const NOVEMBER: BarredAmountDto = {
  month: "2026-11",
  baselineCents: 54_300_000,
  barred: {
    totalCents: 12_000_000,
    byException: [
      { classification: "E6", exceptionCode: "E6", exceptionName: "Duplicidade", cents: 9_000_000, count: 2 },
      { classification: "E1", exceptionCode: "E1", exceptionName: "Falta física", cents: 3_000_000, count: 1 },
    ],
  },
  ifApprovedAsProposed: {
    totalCents: 3_700_000,
    byException: [
      { classification: "E6", exceptionCode: "E6", exceptionName: "Duplicidade", cents: 2_500_000, count: 1 },
      { classification: "E2", exceptionCode: "E2", exceptionName: "Item trocado", cents: 1_200_000, count: 1 },
    ],
  },
  daily: [
    { day: "2026-11-03", barredCumulativeCents: 3_000_000, proposedCumulativeCents: 1_200_000, doublePaymentCumulativeCents: 0 },
    { day: "2026-11-10", barredCumulativeCents: 12_000_000, proposedCumulativeCents: 3_700_000, doublePaymentCumulativeCents: 9_000_000 },
  ],
};

const EMPTY: BarredAmountDto = {
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
  return render(<BarredAmountRoute params={{}} />);
}

/** #71: o cartão do `Stat` cuja legenda é `caption`. */
async function statCard(caption: string): Promise<HTMLElement> {
  const label = (await screen.findAllByText(caption))[0]!;
  let card: HTMLElement | null = label;
  while (card && !card.textContent?.includes("R$") && !card.textContent?.includes("%")) card = card.parentElement;
  if (!card) throw new Error(`sem cartão para ${caption}`);
  return card;
}

afterEach(() => vi.unstubAllGlobals());

describe("#71 painel do valor barrado no mês", () => {
  it("pede o endpoint do painel", async () => {
    const fetchMock = respondWith(200, NOVEMBER);
    renderPanel();
    await screen.findByText("Evitado em novembro");
    expect(fetchMock).toHaveBeenCalledWith("/api/valor-barrado", expect.objectContaining({ method: "GET" }));
  });

  it("#71/AC-1 o ranking mostra cada exceção com o valor, barrado e aguardando somados", async () => {
    respondWith(200, NOVEMBER);
    renderPanel();
    const title = await screen.findByRole("heading", { name: "Valor em risco por exceção" });
    const ranking = title.closest("section") ?? title.parentElement!.parentElement!.parentElement!;
    const e6 = await within(ranking).findByText("Duplicidade");
    expect(e6).toBeTruthy();
    const barredByException = NOVEMBER.barred.byException.reduce((sum, item) => sum + item.cents, 0);
    expect(barredByException).toBe(NOVEMBER.barred.totalCents);
    expect(within(ranking).getByText("Falta física")).toBeTruthy();
    expect(within(ranking).getByText("Item trocado")).toBeTruthy();
    expect(within(ranking).getByText("R$ 115 mil")).toBeTruthy();
    expect(within(ranking).getByText("R$ 30 mil")).toBeTruthy();
    expect(within(ranking).getByText("R$ 12 mil")).toBeTruthy();
    expect(within(ranking).getByText("3 notas")).toBeTruthy();
  });

  it("#71/AC-2 a linha de base de R$ 543 mil aparece ao lado", async () => {
    respondWith(200, NOVEMBER);
    renderPanel();
    expect(await screen.findByText("O mês contra a perda de R$ 543 mil")).toBeTruthy();
    const lossCard = await statCard("Perda mensal hoje");
    expect(within(lossCard).getByText("R$ 543 mil")).toBeTruthy();
    expect(within(lossCard).getByText("pago sem mercadoria correspondente, menos o recuperado (P1)")).toBeTruthy();
  });

  it("#71/AC-3 o Evitado é só o decidido, sem somar o Em decisão, e sem a duplicidade (#125)", async () => {
    respondWith(200, NOVEMBER);
    renderPanel();
    const avoidedCard = await statCard("Evitado em novembro");
    expect(within(avoidedCard).getByText("R$ 30 mil")).toBeTruthy();
    expect(within(avoidedCard).queryByText("R$ 120 mil")).toBeNull();
    expect(within(avoidedCard).getByText(/6% da perda mensal/)).toBeTruthy();
    const decidingCard = await statCard("Em decisão");
    expect(within(decidingCard).getByText("R$ 12 mil")).toBeTruthy();
  });

  it("#125 pergunta 5: E6 e E7 ficam numa linha separada, fora da comparação com os R$ 543 mil", async () => {
    respondWith(200, NOVEMBER);
    renderPanel();
    const doubleCard = await statCard("Pagamento em dobro evitado");
    expect(within(doubleCard).getByText("R$ 90 mil")).toBeTruthy();
    expect(within(doubleCard).getByText(/fora da perda mensal; mais R\$ 25 mil em decisão/)).toBeTruthy();
    expect(screen.getByText("R$ 42 mil de R$ 543 mil")).toBeTruthy();
  });

  it("#192/AC-1 #192/AC-4 the four cards share one two-column grid", async () => {
    respondWith(200, NOVEMBER);
    const { container } = renderPanel();
    const cards = await Promise.all(
      ["Evitado em novembro", "Perda mensal hoje", "Em decisão", "Pagamento em dobro evitado"].map(statCard),
    );
    const grids = Array.from(container.querySelectorAll<HTMLElement>("div")).filter(
      (el) => el.style.getPropertyValue("--stat-columns") !== "",
    );
    expect(grids).toHaveLength(1);
    const grid = grids[0]!;
    expect(grid.style.getPropertyValue("--stat-columns")).toBe("2");
    for (const card of cards) expect(grid.contains(card)).toBe(true);
  });

  it("#170/AC-2 o acumulado volta a mostrar a linha tracejada dos R$ 543 mil, sem a série do pagamento em dobro", async () => {
    respondWith(200, NOVEMBER);
    renderPanel();
    await statCard("Evitado em novembro");
    expect(screen.getAllByText("R$ 543 mil por mês").length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/contra R\$ 543 mil/)).toBeTruthy();
    expect(screen.queryByText(/dobro.*acumulado|Pagamento em dobro, acumulado/)).toBeNull();
  });

  it("#71/AC-4 o total exibido bate com a soma das exceções da resposta", async () => {
    respondWith(200, NOVEMBER);
    renderPanel();
    const double = (b: BarredAmountDto["barred"]) => b.byException.filter((e) => e.classification === "E6" || e.classification === "E7").reduce((s, e) => s + e.cents, 0);
    const barredSum = NOVEMBER.barred.byException.reduce((s, e) => s + e.cents, 0);
    const waitingSum = NOVEMBER.ifApprovedAsProposed.byException.reduce((s, e) => s + e.cents, 0);
    expect(barredSum).toBe(NOVEMBER.barred.totalCents);
    const avoided = barredSum - double(NOVEMBER.barred);
    const deciding = waitingSum - double(NOVEMBER.ifApprovedAsProposed);
    const avoidedCard = await statCard("Evitado em novembro");
    expect(within(avoidedCard).getByText(formatBrlShort(avoided))).toBeTruthy();
    const decidingCard = await statCard("Em decisão");
    expect(within(decidingCard).getByText(formatBrlShort(deciding))).toBeTruthy();
    expect(screen.getByText(`${formatBrlShort(avoided + deciding)} de R$ 543 mil`)).toBeTruthy();
  });

  it("sem nada barrado nem aguardando, mostra o estado vazio", async () => {
    respondWith(200, EMPTY);
    renderPanel();
    expect(await screen.findByText(/Nada evitado neste mês ainda/)).toBeTruthy();
  });

  it("a API em 502 mostra a casca de erro com o tentar de novo", async () => {
    respondWith(502, { error: "upstream" });
    renderPanel();
    expect(await screen.findByText("Não consegui somar o pagamento errado evitado agora")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });
});

describe("#71 dinheiro em centavos inteiros", () => {
  it("formatBrlShort arredonda em mil a partir de centavos e mostra por extenso abaixo de R$ 1.000", () => {
    expect(formatBrlShort(54_300_000)).toBe("R$ 543 mil");
    expect(formatBrlShort(99_999).replace(/\s/g, " ")).toBe("R$ 999,99");
  });
});
