import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProposalTimeline } from "./ProposalTimeline";

// #211 AC-4: "Como esta nota andou", na ordem que a API manda, com a hora, o passo e o selo de quem fez.
const steps = [
  { at: "2026-11-15T13:00:00Z", kind: "captura", step: "Capturada na SEFAZ", actor: "system", actor_name: "Automático" },
  { at: "2026-11-15T13:00:00Z", kind: "conferencia", step: "Conferida: E4", actor: "rule", actor_name: "Regra" },
  { at: "2026-11-15T13:12:00Z", kind: "decisao", step: "Aprovada: receber", actor: "person", actor_name: "Ana Souza" },
] as const;

describe("#211 ProposalTimeline", () => {
  it("mostra o título, cada passo na ordem, a hora de Brasília e o selo de quem fez", () => {
    render(<ProposalTimeline steps={[...steps]} />);
    expect(screen.getByText("Como esta nota andou")).toBeTruthy();
    const texts = screen.getAllByText(/Capturada|Conferida|Aprovada/).map((n) => n.textContent);
    expect(texts).toEqual(["Capturada na SEFAZ", "Conferida: E4", "Aprovada: receber"]);
    expect(screen.getByText("10h12")).toBeTruthy();
    expect(screen.getByText("⚙ Automático")).toBeTruthy();
    expect(screen.getByText("⚙ Regra")).toBeTruthy();
    expect(screen.getByText("Ana Souza")).toBeTruthy();
  });
  it("sem passos, diz que ainda não há", () => {
    render(<ProposalTimeline steps={[]} />);
    expect(within(document.body).getByText(/Ainda não há passos/)).toBeTruthy();
  });
});
