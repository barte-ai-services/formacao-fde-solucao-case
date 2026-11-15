import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* #222 A responsividade, lida do app.css. Sem layout no jsdom, o teste afirma as regras (sem px fixo à mão);
   a medida da rolagem fica no navegador, no relato do PR. */

const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sel]) => sel!.split(",").some((s) => s.trim() === selector))
    .map(([, , body]) => body!);
  if (bodies.length === 0) throw new Error(`sem regra para ${selector}`);
  return bodies.join("\n");
}

describe("#222 a grid rola na própria caixa e não alarga a página", () => {
  it("a caixa da tabela limita a largura e rola na horizontal", () => {
    const body = rule(".pagar-row-table");
    expect(body).toMatch(/max-width:\s*100%/);
    expect(body).toMatch(/overflow-x:\s*auto/);
  });

  it("a NF (primeira coluna) fica fixa à esquerda", () => {
    expect(rule(".pagar-row-table tbody td:first-child, .pagar-row-table thead th:first-child".split(",")[0]!)).toMatch(/position:\s*sticky/);
  });
});

describe("#222 #242 a faixa de automação empilha no celular", () => {
  it("abaixo de 600 px a ação desce para baixo do texto, alinhada a ele, sem mirar classes internas do kit", () => {
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*grid-template-areas:\s*"i t" "\. a"/);
    expect(css).toMatch(/pagar-automation-band__action\s*\{[^}]*grid-area:\s*a/);
    expect(css).not.toMatch(/Alert-module__/);
  });
  it("a faixa só usa tokens do design system, nenhuma cor fixa", () => {
    const rules = css.match(/\.pagar-automation-band[^{]*\{[^}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
});

describe("#222 as células da grid ficam compactas no celular", () => {
  it("o respiro lateral da célula vem de token abaixo de 600 px", () => {
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*pagar-row-table table td[\s\S]*padding-inline:\s*var\(--spacing-sm\)/);
  });
});
