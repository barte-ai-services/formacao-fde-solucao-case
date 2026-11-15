import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DecidedBy } from "./DecidedBy";

// #211 AC-3: o selo de quem decidiu é um componente só, com a cor da legenda do BPMN alvo: sistema e regra azul, agente rosa, pessoa laranja.
describe("#211 DecidedBy", () => {
  it("sistema e regra: o texto e o tom azul (info)", () => {
    const { container, rerender } = render(<DecidedBy actor="system" />);
    expect(screen.getByText("⚙ Automático")).toBeTruthy();
    expect(container.querySelector("[class*='info']")).toBeTruthy();
    rerender(<DecidedBy actor="rule" />);
    expect(screen.getByText("⚙ Regra")).toBeTruthy();
    expect(container.querySelector("[class*='info']")).toBeTruthy();
  });
  it("Claude e motor: o AiSourceBadge do kit, em rosa, com o nome", () => {
    const { rerender } = render(<DecidedBy actor="claude" />);
    expect(screen.getByText("Claude")).toBeTruthy();
    rerender(<DecidedBy actor="engine" name="Motor 0,99" />);
    expect(screen.getByText("Motor 0,99")).toBeTruthy();
  });
  it("pessoa: o nome, em laranja (waiting)", () => {
    const { container } = render(<DecidedBy actor="person" name="Ana Souza" />);
    expect(screen.getByText("Ana Souza")).toBeTruthy();
    expect(container.querySelector("[class*='waiting']")).toBeTruthy();
  });
  it("pessoa sem nome não some: mostra 'Pessoa'", () => {
    render(<DecidedBy actor="person" />);
    expect(screen.getByText("Pessoa")).toBeTruthy();
  });
});
