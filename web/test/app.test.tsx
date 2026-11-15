import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { fallbackContext, loadShellContext } from "../src/shell/context";

describe("moldura", () => {
  it("mostra o carregando de página enquanto o contexto chega, e depois a moldura", async () => {
    window.history.replaceState(null, "", "/pagar/hoje");
    let resolve: (value: ReturnType<typeof fallbackContext>) => void = () => {};
    render(<App loadContext={() => new Promise((r) => (resolve = r))} />);
    expect(screen.getByText("Abrindo o contas a pagar…")).toBeTruthy();
    resolve(fallbackContext(null));
    expect(await screen.findByRole("heading", { name: "Lista do dia" })).toBeTruthy();
    expect(screen.getAllByText("Pessoa da Já Chegou").length).toBeGreaterThan(0);
  });

  it("sem VITE_SHELL_URL usa o contexto fixo com o e-mail do /me", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ email: "aluna@barte.com" })));
    const context = await loadShellContext(undefined);
    expect(context.user?.email).toBe("aluna@barte.com");
    expect(context.brand.name).toBe("Já Chegou");
    vi.unstubAllGlobals();
  });

  it("com o Shell fora do ar, cai no contexto fixo", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/api/shell/context") ? new Response("", { status: 500 }) : Response.json({ email: null }),
    ));
    const context = await loadShellContext("https://shell.exemplo.com");
    expect(context.user?.name).toBe("Pessoa da Já Chegou");
    vi.unstubAllGlobals();
  });
});
