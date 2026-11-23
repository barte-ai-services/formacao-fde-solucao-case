import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationDto, AutomationRunDto } from "../src/api/automation";
import { Frame } from "../src/App";
import { fallbackContext } from "../src/shell/context";

// #372 A faixa de automação herda o MESMO contêiner das telas (`.shell-home`): a largura e o respiro até o título
// #372 vêm do contêiner, não de uma margem própria da faixa. Sem layout no jsdom, o teste afirma a estrutura e o CSS.
const indicators: AutomationDto["indicators"] = {
  day: { date: "2026-11-16", decided: 0, byRule: 0, withoutPersonPct: null, medianSeconds: { withoutPerson: null, withPerson: null } },
  month: { month: "2026-11", decided: 0, byRule: 0, withoutPersonPct: null, medianSeconds: { withoutPerson: null, withPerson: null } },
};
const rodada: AutomationRunDto = {
  id: 1, startedAt: "2026-11-16T13:15:00Z", finishedAt: "2026-11-16T13:15:00Z", status: "ok", error: null,
  figures: { seen: 3, inserted: 3, checked: 3, failed: 0, proposed: 2, approvedByRule: 1, cadastroE8: 0, dockPublished: 1, storePublished: 0, duplicatesBlocked: 0 },
};
const dto: AutomationDto = {
  state: "ok", last: rodada, next: "2026-11-16T13:30:00Z", runs: [rodada], indicators,
  demo: { enabled: false, changedAt: null }, intervalMinutes: 15, skipped: [], isAdmin: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROTAS = [
  ["Fila", "/pagar/fila"], // ADR-004
  ["Lista do dia", "/pagar/hoje"],
  ["Duplicadas", "/pagar/duplicadas"],
  ["Valor barrado", "/pagar/valor-barrado"],
  ["Ao vivo", "/pagar/ao-vivo"],
  ["Doca", "/doca"],
] as const;

// #372 A API da automação responde `auto` (ou erro, para a faixa sumir); o resto das telas recebe listas vazias.
const emptyApi = (auto: AutomationDto | null = dto) =>
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    String(url).includes("/api/automacao")
      ? auto ? Response.json(auto) : new Response("", { status: 500 })
      : Response.json({ rows: [], items: [], next: null })));

describe("#372 a faixa de automação divide o contêiner da tela", () => {
  it.each(ROTAS)("%s: faixa e tela são irmãs dentro de um mesmo .shell-home", async (_nome, caminho) => {
    emptyApi();
    window.history.replaceState(null, "", caminho);
    const { container } = render(<Frame context={fallbackContext(null)} />);
    const faixa = await vi.waitFor(() => {
      const el = container.querySelector(".pagar-automation-band");
      if (!el) throw new Error("faixa ainda não chegou");
      return el;
    });
    const screenEl = container.querySelector(".shell-home.pagar-screen");
    expect(screenEl).not.toBeNull();
    const conteiner = faixa.parentElement!;
    expect(conteiner.classList.contains("shell-home")).toBe(true);
    expect(conteiner.classList.contains("pagar-screen")).toBe(false);
    expect(screenEl!.parentElement).toBe(conteiner);
    expect(screen.getAllByRole("heading").length).toBeGreaterThan(0);
  });

  it("sem a faixa (não carregou), o contêiner guarda só a tela: nenhum espaço extra", async () => {
    emptyApi(null);
    window.history.replaceState(null, "", "/pagar/hoje");
    const { container } = render(<Frame context={fallbackContext(null)} />);
    await screen.findByRole("heading", { name: "Lista do dia" });
    expect(container.querySelector(".pagar-automation-band")).toBeNull();
    const screenEl = container.querySelector(".shell-home.pagar-screen")!;
    expect(screenEl.parentElement!.classList.contains("shell-home")).toBe(true);
    expect(screenEl.parentElement!.children).toHaveLength(1);
  });
});

describe("#372 o CSS da faixa não tem margem própria", () => {
  const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // #372 Só o seletor `.pagar-automation-band` sozinho; a regra dentro do @media também conta.
  const corpos = [...css.matchAll(/(?:^|[{}])\s*\.pagar-automation-band\s*\{([^}]*)\}/g)].map(([, body]) => body!);

  it("há as duas regras: a do desktop e a do celular", () => {
    expect(corpos).toHaveLength(2);
  });
  it.each([0, 1])("o bloco %i não declara margin", (i) => {
    expect(corpos[i]).not.toMatch(/(^|[;\s])margin(-[a-z]+)?\s*:/);
  });
});
