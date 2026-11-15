import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GridFilter } from "./GridFilter";

/* #207 (plano #208): a pílula de filtro das grids é o SegmentedFilter do kit, "gordinha": o texto (e o contador)
   vêm do tamanho `base` do kit (body-sm), e a altura e o respiro, de tokens do design system aplicados só aqui.
   Sem layout no jsdom, o teste afirma as regras do componente (por token, sem px) e a conta da altura. */

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

  it("AC2: altura e respiro horizontal por token, e nenhuma regra mira o texto do kit", () => {
    const pill = rule(PILL);
    expect(pill).toMatch(/height:\s*var\(--sizes-3xl\)/);
    expect(pill).toMatch(/padding:\s*0 var\(--spacing-md\)/);
    // #207: o tamanho do texto vem do `size="base"` do kit, não de CSS que mire uma classe privada do Text.
    expect(css).not.toMatch(/Text-module/);
    expect(css).not.toMatch(/font-size|line-height/);
  });

  it("AC2: o tamanho base do kit está aplicado, o texto sobe de body-xs para body-sm e o contador segue legível ao lado do rótulo", () => {
    renderFilter();
    for (const radio of screen.getAllByRole("radio")) {
      const pill = radio.firstElementChild!;
      expect(pill.className).toMatch(/Pills-module__base__/);
      expect(pill.className).not.toMatch(/Pills-module__sm__/);
      const text = pill.firstElementChild!;
      expect(text.className).toMatch(/Text-module__bodySm__/);
      expect(text.className).not.toMatch(/Text-module__bodyXs__/);
      // rótulo e contador no mesmo texto, não cortados nem em outro nó.
      expect(text.textContent).toMatch(/^(Todas · 66|Minhas · 12)$/);
    }
  });

  it("AC2: todo seletor privado do kit que o CSS ainda mira casa com um elemento do DOM, para a troca de nome no kit ficar vermelha", () => {
    renderFilter();
    const selectors = [...css.matchAll(/\[class\*="[^"]+"\]/g)].map(([s]) => s);
    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors).toContain('[class*="SegmentedFilter-module__pill"]');
    for (const selector of new Set(selectors)) {
      expect(document.querySelectorAll(`.grid-filter ${selector}`).length, selector).toBeGreaterThan(0);
    }
  });

  it("AC2: é mais denso que a pílula padrão do kit (altura 3xl contra o miolo xs com respiro 2xs, respiro md contra sm) e o texto base cabe na altura", () => {
    const kitHeight = rem("--typography-body-xs-fontSize") * 1.333 + 2 * rem("--spacing-2xs");
    expect(rem("--sizes-3xl")).toBeGreaterThan(kitHeight);
    expect(rem("--spacing-md")).toBeGreaterThan(rem("--spacing-sm"));
    // #207: o texto cabe na altura da pílula.
    expect(rem("--typography-body-sm-fontSize") * 1.429).toBeLessThanOrEqual(rem("--sizes-3xl"));
  });

  it("AC2: sem px fixo nem cor fixa, só var() do design system", () => {
    expect(css).not.toMatch(/\d\s*px/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/rgb/i);
  });
});
