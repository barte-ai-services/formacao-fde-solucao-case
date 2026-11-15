import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GridFilter } from "./GridFilter";

/* #207 (plano #208): a pílula de filtro das grids é o SegmentedFilter do kit, "gordinha", com tokens do design
   system aplicados só aqui. Sem layout no jsdom, o teste afirma as regras do componente (por token, sem px) e a
   conta da altura. */

const css = readFileSync(resolve(process.cwd(), "src/components/GridFilter.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const dsCss = readFileSync(resolve(process.cwd(), "node_modules/barte-design-system/dist/barte-design-system.css"), "utf8");

function rule(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sel]) => sel!.split(",").some((s) => s.trim() === selector))
    .map(([, , body]) => body!);
  if (bodies.length === 0) throw new Error(`sem regra para ${selector}`);
  return bodies.join("\n");
}

/** #207: o valor do token em rem, lido do design system. */
function rem(token: string): number {
  const match = dsCss.match(new RegExp(`${token}:\\s*(\\.?\\d*\\.?\\d+)rem`));
  if (!match) throw new Error(`sem token ${token}`);
  return Number(match[1]);
}

const PILL = '.grid-filter.grid-filter [class*="SegmentedFilter-module__pill"]';
const TEXT = '.grid-filter.grid-filter [class*="SegmentedFilter-module__pill"] [class*="Text-module__text"]';

function renderFilter(onChange = vi.fn()) {
  render(
    <GridFilter
      ariaLabel="Visão"
      value="all"
      onChange={onChange}
      options={[
        { value: "all", label: "Todas", count: 66 },
        { value: "mine", label: "Minhas", count: 12 },
      ]}
    />,
  );
  return onChange;
}

describe("#207 GridFilter", () => {
  it("AC1/AC4: desenha o grupo de rádio do kit com a classe compartilhada", () => {
    renderFilter();
    const group = screen.getByRole("radiogroup", { name: "Visão" });
    expect(group.parentElement!.className).toContain("grid-filter");
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("AC3/AC4: o selecionado e o não selecionado seguem distintos no estado e no fundo e texto do DS", () => {
    renderFilter();
    const [selected, other] = screen.getAllByRole("radio") as [HTMLElement, HTMLElement];
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(other.getAttribute("aria-checked")).toBe("false");
    // #207 AC3: o DS pinta o marcado cheio (fill) e o outro vazado (ghost); a classe do app não mexe em nenhum dos dois.
    expect(selected.firstElementChild!.className).toMatch(/Pills-module__fill__/);
    expect(selected.firstElementChild!.className).not.toMatch(/Pills-module__ghost__/);
    expect(other.firstElementChild!.className).toMatch(/Pills-module__ghost__/);
    expect(other.firstElementChild!.className).not.toMatch(/Pills-module__fill__/);
    expect(css).not.toMatch(/background|(^|[\s;{])color\s*:/);
  });

  it("AC2/AC4: o contador aparece junto do rótulo, em cada pílula", () => {
    renderFilter();
    expect(screen.getByText("Todas · 66")).toBeTruthy();
    expect(screen.getByText("Minhas · 12")).toBeTruthy();
  });

  it("AC4: escolher a outra pílula avisa a escolha", () => {
    const onChange = renderFilter();
    fireEvent.click(screen.getByRole("radio", { name: /Minhas/ }));
    expect(onChange).toHaveBeenCalledWith("mine");
  });

  it("AC2: altura, respiro vertical e horizontal e texto (e contador) um degrau acima do body-xs, por token", () => {
    const pill = rule(PILL);
    expect(pill).toMatch(/height:\s*var\(--sizes-3xl\)/);
    expect(pill).toMatch(/padding:\s*0 var\(--spacing-md\)/);
    const text = rule(TEXT);
    expect(text).toMatch(/font-size:\s*var\(--typography-body-sm-fontSize\)/);
    expect(text).toMatch(/line-height:\s*var\(--typography-body-sm-lineHeight\)/);
  });

  it("AC2: é mais denso que a pílula do kit (altura 3xl contra o miolo xs com respiro 2xs, respiro md contra sm, texto sm contra xs)", () => {
    const kitHeight = rem("--typography-body-xs-fontSize") * 1.333 + 2 * rem("--spacing-2xs");
    expect(rem("--sizes-3xl")).toBeGreaterThan(kitHeight);
    expect(rem("--spacing-md")).toBeGreaterThan(rem("--spacing-sm"));
    expect(rem("--typography-body-sm-fontSize")).toBeGreaterThan(rem("--typography-body-xs-fontSize"));
    // #207: o texto cabe na altura da pílula.
    expect(rem("--typography-body-sm-fontSize") * 1.429).toBeLessThanOrEqual(rem("--sizes-3xl"));
  });

  it("AC2: sem px fixo nem cor fixa, só var() do design system", () => {
    expect(css).not.toMatch(/\d\s*px/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/rgb/i);
  });
});
