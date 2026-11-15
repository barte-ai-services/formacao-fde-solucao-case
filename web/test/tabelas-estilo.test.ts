import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* #127 #121 #122 O estilo compartilhado das tabelas e do filtro em pílula, lido do app.css. Sem layout no jsdom,
   o teste afirma as regras (por token, sem px fixo); a medida no navegador fica no relato da camada. */

const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sel]) => sel!.split(",").some((s) => s.trim() === selector))
    .map(([, , body]) => body!);
  if (bodies.length === 0) throw new Error(`sem regra para ${selector}`);
  return bodies.join("\n");
}

describe("#127 corpo, texto secundário e cabeçalho das tabelas no token de corpo do DS", () => {
  it.each([
    ["td", "table td"],
    ["th", "table th"],
    ["caption-sm", 'table [class*="Text-module__captionSm"]'],
    ["selo (StatusBadge)", 'table [class*="StatusBadge-module__label"]'],
  ])("%s tem fonte por var(--typography-body-xs-fontSize)", (_name, selector) => {
    expect(rule(selector)).toMatch(/font-size:\s*var\(--typography-body-xs-fontSize\)/);
  });

  it("a altura da linha cresce com o conteúdo, por token, sem cortar selo", () => {
    const body = rule("table td");
    expect(body).toMatch(/height:\s*var\(--sizes-6xl\)/);
    expect(body).toMatch(/overflow:\s*visible/);
    expect(rule("table td")).toMatch(/font-size/);
    expect(css).toMatch(/table td,\s*table th\s*\{[^}]*line-height:\s*var\(--typography-body-xs-lineHeight\)/);
  });

  it("não usa px fixo para tamanho de fonte", () => {
    expect(css).not.toMatch(/font-size:\s*[\d.]+px/);
  });
});

describe("#122 colunas de valor à direita, dígitos tabulares", () => {
  it("o cabeçalho right alinha o conteúdo interno à direita", () => {
    // #122 th > cellContentWrapper > headerCellContent: os dois miolos são flex e nenhum herda o alinhamento do th.
    expect(css).toMatch(/\[class\*="headerCell--right"\]\s*\[class\*="cellContentWrapper"\][^{]*\{[^}]*justify-content:\s*flex-end/);
    expect(css).toMatch(/\[class\*="headerCell--right"\]\s*\[class\*="headerCellContent"\][^{]*\{[^}]*justify-content:\s*flex-end/);
  });

  it("a célula right alinha o conteúdo interno à direita e usa tabular-nums", () => {
    expect(rule('[class*="cell--right"]')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(css).toMatch(/\[class\*="cell--right"\]\s*>\s*\[class\*="cellContentWrapper"\][^{]*\{[^}]*justify-content:\s*flex-end/);
  });
});

describe("#121 o filtro em pílula do Shell", () => {
  it("existe .shell-connections-filters com o espaçamento por token", () => {
    const body = rule(".shell-connections-filters");
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/gap:\s*var\(--spacing-sm\)/);
  });

  it("existe .shell-connections-filter sem moldura de botão e com foco por token", () => {
    expect(rule(".shell-connections-filter")).toMatch(/border-radius:\s*var\(--border-radius-full\)/);
    expect(rule(".shell-connections-filter:focus-visible")).toMatch(/var\(--stroke-brand\)/);
  });

  it("o botão não tem moldura própria: a medida da pílula é a do Pills do DS, como no Shell", () => {
    const body = rule(".shell-connections-filter");
    expect(body).toMatch(/padding:\s*0/);
    expect(body).toMatch(/border:\s*0/);
  });
});
