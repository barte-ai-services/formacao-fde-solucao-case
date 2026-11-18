import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";
import { Screen } from "./Screen";

// #123 O vazio fica fora do `InlineEmpty` do kit (flex à esquerda, encolhe o filho): o centro depende disso.
describe("#123 Screen vazia", () => {
  it("desenha o EmptyState direto na tela, e não dentro do texto de vazio do kit", () => {
    render(
      <Screen
        title="Tela"
        state="empty"
        loadingLabel="Carregando…"
        errorTitle="Erro"
        emptyLabel="vazio em texto"
        onRetry={() => {}}
        empty={<EmptyState title="Nada aqui" description="Explicação." />}
      />,
    );
    const block = screen.getByText("Nada aqui").closest(".pagar-empty")!;
    expect(block).toBeTruthy();
    expect(block.closest("p")).toBeNull();
    expect(screen.queryByText("vazio em texto")).toBeNull();
  });

  it("sem `empty`, cai no texto de vazio", () => {
    render(<Screen title="Tela" state="empty" loadingLabel="…" errorTitle="Erro" emptyLabel="vazio em texto" onRetry={() => {}} />);
    expect(screen.getByText("vazio em texto")).toBeTruthy();
  });
});
