import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("../router", () => ({ navigate }));

// #123/AC-1: título, explicação e, quando couber, uma ação.
describe("#123 EmptyState", () => {
  it("mostra título e explicação, e a ação leva à tela pedida", () => {
    render(<EmptyState title="Nada aqui" description="Aparece quando houver." action={{ label: "Ver a fila", to: "/pagar/fila" }} />);
    expect(screen.getByText("Nada aqui")).toBeTruthy();
    expect(screen.getByText("Aparece quando houver.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver a fila" }));
    expect(navigate).toHaveBeenCalledWith("/pagar/fila");
  });

  it("sem ação, não desenha botão", () => {
    render(<EmptyState title="Nada aqui" description="Aparece quando houver." />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
