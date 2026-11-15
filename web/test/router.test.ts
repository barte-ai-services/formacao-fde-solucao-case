import { describe, expect, it } from "vitest";
import { matchPath, matchRoute } from "../src/router";
import { ROUTES } from "../src/routes";

describe("roteador", () => {
  it("casa /pagar/fila/:id e entrega o parâmetro", () => {
    expect(matchPath("/pagar/fila/:id", "/pagar/fila/abc-123")).toEqual({ id: "abc-123" });
    expect(matchPath("/pagar/fila/:id", "/pagar/fila/abc%20123/")).toEqual({ id: "abc 123" });
  });

  it("não casa caminho com segmentos a mais, a menos, ou com escape inválido", () => {
    expect(matchPath("/pagar/fila/:id", "/pagar/fila")).toBeNull();
    expect(matchPath("/pagar/fila/:id", "/pagar/fila/1/2")).toBeNull();
    expect(matchPath("/pagar/fila/:id", "/pagar/fila/%E0%A4%A")).toBeNull();
  });

  it("a fila e a proposta são rotas diferentes na tabela", () => {
    expect(matchRoute(ROUTES, "/pagar/fila")?.route.path).toBe("/pagar/fila");
    expect(matchRoute(ROUTES, "/pagar/fila/9")?.route.path).toBe("/pagar/fila/:id");
    expect(matchRoute(ROUTES, "/constructor")).toBeNull();
  });
});
