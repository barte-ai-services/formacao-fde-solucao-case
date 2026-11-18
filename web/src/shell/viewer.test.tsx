import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useViewer, ViewerProvider } from "./viewer";

// #156 Quem olha a tela chega à gaveta pelo contexto da moldura, sem passar por props de rota.

function Show() {
  return <p>{`viewer:${useViewer()}`}</p>;
}

describe("#156 quem está olhando", () => {
  it("#156: o e-mail da moldura chega a quem o lê", () => {
    render(
      <ViewerProvider email="ana@jachegou.test">
        <Show />
      </ViewerProvider>,
    );
    expect(screen.getByText("viewer:ana@jachegou.test")).toBeTruthy();
  });

  it("#156: sem e-mail na moldura, ninguém é você (texto vazio)", () => {
    render(
      <ViewerProvider email={null}>
        <Show />
      </ViewerProvider>,
    );
    expect(screen.getByText("viewer:")).toBeTruthy();
  });

  it("#156: fora da moldura, o padrão também é vazio", () => {
    render(<Show />);
    expect(screen.getByText("viewer:")).toBeTruthy();
  });
});
