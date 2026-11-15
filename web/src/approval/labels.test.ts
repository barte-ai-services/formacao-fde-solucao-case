import { describe, expect, it } from "vitest";
import { codeLabel } from "./labels";

// #201 AC3 (revisado): na coluna "Código" da fila e da lista do dia, MATCH não é código de exceção.
describe("#201 codeLabel", () => {
  it("AC3: MATCH aparece como traço", () => {
    expect(codeLabel("MATCH")).toBe("—");
  });

  it("AC3: o código de exceção continua aparecendo", () => {
    expect(codeLabel("E3")).toBe("E3");
  });

  it("AC3: NAO_CATALOGADA continua aparecendo", () => {
    expect(codeLabel("NAO_CATALOGADA")).toBe("NAO_CATALOGADA");
  });
});
