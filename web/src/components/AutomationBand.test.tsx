import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AutomationDto, AutomationRunDto } from "../api/automation";
import { AutomationProvider } from "./automation-context";
import { AutomationBand } from "./AutomationBand";
import { AutomationIndicators } from "./AutomationIndicators";

// #211 AC-2 e AC-5: a faixa de automação e os indicadores, sobre o que a API entrega.
const run = (id: number, startedAt: string, status: "ok" | "failed" = "ok"): AutomationRunDto => ({
  id, startedAt, finishedAt: startedAt, status, error: null,
  figures: { seen: 12, inserted: 12, checked: 12, failed: 0, proposed: 11, approvedByRule: 7, cadastroE8: 0, dockPublished: 5, storePublished: 0, duplicatesBlocked: 0 },
});
const indicators: AutomationDto["indicators"] = {
  day: { date: "2026-11-16", decided: 4, byRule: 3, withoutPersonPct: 75, medianSeconds: { withoutPerson: 600, withPerson: 3900 } },
  month: { month: "2026-11", decided: 5, byRule: 3, withoutPersonPct: 60, medianSeconds: { withoutPerson: 600, withPerson: 3900 } },
};
// 13h15 UTC = 10h15 em Brasília
const dto = (state: AutomationDto["state"], last: AutomationRunDto | null): AutomationDto => ({
  state, last, next: "2026-11-16T13:30:00Z", runs: last ? [last] : [], indicators,
});
const NOW = () => new Date("2026-11-16T13:18:00Z");
const band = (d: AutomationDto) =>
  render(
    <AutomationProvider load={async () => d}>
      <AutomationBand now={NOW} />
    </AutomationProvider>,
  );

describe("#211 AC-2 faixa de automação", () => {
  it("ok: a última rodada, a próxima e o que ela fez", async () => {
    band(dto("ok", run(1, "2026-11-16T13:15:00Z")));
    expect(await screen.findByText("⚙ Automático · última rodada às 10h15 (há 3 min) · próxima às 10h30")).toBeTruthy();
    expect(screen.getByText("12 notas capturadas · 12 conferidas · 7 aprovadas pela regra · 4 para pessoa · 5 ações publicadas na doca")).toBeTruthy();
    expect(document.querySelector("[data-state='ok']")).toBeTruthy();
  });
  it("falhou: âmbar (warning) com a próxima tentativa", async () => {
    band(dto("failed", run(1, "2026-11-16T13:15:00Z", "failed")));
    expect(await screen.findByText("A última rodada falhou às 10h15. A próxima tenta de novo às 10h30.")).toBeTruthy();
    expect(document.querySelector("[data-state='failed']")).toBeTruthy();
  });
  it("parada: vermelha, desde a última rodada", async () => {
    band(dto("stalled", run(1, "2026-11-16T12:45:00Z")));
    expect(await screen.findByText("A automação está parada desde 9h45.")).toBeTruthy();
    expect(document.querySelector("[data-state='stalled']")).toBeTruthy();
  });
  it("ok sem nenhuma rodada: nenhuma faixa vazia", async () => {
    const { container } = render(
      <AutomationProvider load={async () => dto("ok", null)}>
        <AutomationBand now={NOW} />
      </AutomationProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector(".pagar-automation-band")).toBeNull();
  });
  it("singular nos números da faixa", async () => {
    const one = run(1, "2026-11-16T13:15:00Z");
    one.figures = { ...one.figures, inserted: 1, checked: 1, proposed: 2, approvedByRule: 1, dockPublished: 1 };
    band(dto("ok", one));
    expect(await screen.findByText("1 nota capturada · 1 conferida · 1 aprovada pela regra · 1 para pessoa · 1 ação publicada na doca")).toBeTruthy();
  });
  it("nunca rodou: diz que ainda não rodou", async () => {
    band(dto("stalled", null));
    expect(await screen.findByText("A automação ainda não rodou.")).toBeTruthy();
  });
  it("Ver rodadas abre a gaveta com as rodadas", async () => {
    band(dto("ok", run(1, "2026-11-16T13:15:00Z")));
    fireEvent.click(await screen.findByRole("button", { name: "Ver rodadas" }));
    expect(await screen.findByText("Últimas rodadas")).toBeTruthy();
  });
  it("se a API falha, a tela segue sem faixa", async () => {
    const { container } = render(
      <AutomationProvider load={async () => { throw new Error("x"); }}>
        <AutomationBand now={NOW} />
      </AutomationProvider>,
    );
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});

describe("#211 AC-5 indicadores", () => {
  it("mostra o % sem pessoa e a mediana da captura à decisão, como a API manda", async () => {
    render(
      <AutomationProvider load={async () => dto("ok", run(1, "2026-11-16T13:15:00Z"))}>
        <AutomationIndicators />
      </AutomationProvider>,
    );
    expect(await screen.findByText("Resolvidas sem pessoa")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("hoje · no mês: 60%")).toBeTruthy();
    expect(screen.getByText("Da captura à decisão")).toBeTruthy();
    expect(screen.getByText("10 min")).toBeTruthy();
    expect(screen.getByText("sem pessoa · com pessoa: 1 h 05")).toBeTruthy();
  });
  it("sem decisão, mostra — e não um 0 que engana", async () => {
    const base = dto("ok", run(1, "2026-11-16T13:15:00Z"));
    const empty: AutomationDto = {
      ...base,
      indicators: { ...base.indicators, day: { date: "x", decided: 0, byRule: 0, withoutPersonPct: null, medianSeconds: { withoutPerson: null, withPerson: null } } },
    };
    render(
      <AutomationProvider load={async () => empty}>
        <AutomationIndicators />
      </AutomationProvider>,
    );
    expect((await screen.findAllByText("—")).length).toBeGreaterThan(0);
  });
});
