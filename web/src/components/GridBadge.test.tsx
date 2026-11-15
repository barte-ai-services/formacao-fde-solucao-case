import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GridBadge } from "./GridBadge";

/* #201 AC1/AC5/AC6/AC8: o selo das grids é a pílula do kit, "gordinha", com tokens do design system aplicados
   só aqui. Sem layout no jsdom, o teste afirma as regras do componente (por token, sem px) e a conta da altura. */

const css = readFileSync(resolve(process.cwd(), "src/components/GridBadge.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const dsCss = readFileSync(resolve(process.cwd(), "node_modules/barte-design-system/dist/barte-design-system.css"), "utf8");

function rule(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sel]) => sel!.split(",").some((s) => s.trim() === selector))
    .map(([, , body]) => body!);
  if (bodies.length === 0) throw new Error(`sem regra para ${selector}`);
  return bodies.join("\n");
}

/** #201: o valor do token em rem, lido do design system. */
function rem(token: string): number {
  const match = dsCss.match(new RegExp(`${token}:\\s*(\\.?\\d*\\.?\\d+)rem`));
  if (!match) throw new Error(`sem token ${token}`);
  return Number(match[1]);
}

describe("#201 GridBadge", () => {
  it("AC1: desenha o selo do kit no tamanho pílula e com o texto dentro", () => {
    render(<GridBadge>Conferida</GridBadge>);
    const badge = screen.getByText("Conferida").parentElement!;
    expect(badge.className).toMatch(/StatusBadge-module__pill__/);
    expect(badge.className).not.toMatch(/StatusBadge-module__pill-sm__/);
    expect(badge.className).toContain("grid-badge");
  });

  it("AC1: mantém o tom e a variante pedidos: suave por padrão, cheia quando pedida", () => {
    const { rerender } = render(<GridBadge tone="positive">a</GridBadge>);
    let badge = screen.getByText("a").parentElement!;
    expect(badge.className).toMatch(/StatusBadge-module__soft__/);
    expect(badge.className).toMatch(/StatusBadge-module__positive__/);
    rerender(
      <GridBadge tone="negative" variant="solid">
        a
      </GridBadge>,
    );
    badge = screen.getByText("a").parentElement!;
    expect(badge.className).toMatch(/StatusBadge-module__solid__/);
    expect(badge.className).toMatch(/StatusBadge-module__negative__/);
  });

  it("AC5/AC6: altura, respiro, raio de pílula e texto um degrau acima do body-xs, todos por token", () => {
    const body = rule(".grid-badge.grid-badge");
    expect(body).toMatch(/height:\s*var\(--sizes-3xl\)/);
    expect(body).toMatch(/padding:\s*0 var\(--spacing-md\)/);
    expect(body).toMatch(/border-radius:\s*var\(--border-radius-full\)/);
    const label = rule('.grid-badge.grid-badge [class*="StatusBadge-module__label"]');
    expect(label).toMatch(/font-size:\s*var\(--typography-body-sm-fontSize\)/);
    expect(label).toMatch(/line-height:\s*var\(--typography-body-sm-lineHeight\)/);
  });

  it("AC5: é mais gordo que a pílula do kit (altura 2xl, respiro sm, texto xs)", () => {
    expect(rem("--sizes-3xl")).toBeGreaterThan(rem("--sizes-2xl"));
    expect(rem("--spacing-md")).toBeGreaterThan(rem("--spacing-sm"));
    expect(rem("--typography-body-sm-fontSize")).toBeGreaterThan(rem("--typography-body-xs-fontSize"));
  });

  it("AC6: sem px fixo nem cor fixa, só var() do design system", () => {
    expect(css).not.toMatch(/\d\s*px/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/rgb/i);
  });

  it("AC2/AC7: a linha mantém a altura: o selo cabe dentro da linha de duas linhas da InvoiceCell", () => {
    // #201: toda grid tem a InvoiceCell (body-xs + caption-sm) e a célula do DS tem padding spacing-md em cima e embaixo.
    const padding = 2 * rem("--spacing-md");
    const cellContent = rem("--typography-body-xs-fontSize") * 1.333 + rem("--typography-caption-sm-fontSize") * 1.5;
    const rowFromCell = cellContent + padding;
    const rowFromBadge = rem("--sizes-3xl") + padding;
    expect(rowFromBadge).toBeLessThanOrEqual(rowFromCell);
    // #201: a linha com o selo fica acima do piso --sizes-6xl do DS.
    expect(rowFromBadge).toBeGreaterThan(rem("--sizes-6xl"));
  });
});
