import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotaFiscal } from "./NotaFiscal";

// #190/AC-1: número rosa sublinhado, data em tinta, segunda linha cinza.
describe("#190 NotaFiscal", () => {
  it("AC-1: desenha o número em rosa sublinhado, a data e a segunda linha", () => {
    render(<NotaFiscal number="1234" issuedOn="2026-03-05" bottom="Fornecedor · R$ 10,00" onOpen={() => {}} />);
    const numberText = screen.getByText("NF 1234");
    expect(numberText.style.color).toBe("var(--content-brand)");
    expect(numberText.style.textDecoration).toBe("underline");
    expect(screen.getByText(/· 05\/03\/2026/)).toBeTruthy();
    expect(screen.getByText("Fornecedor · R$ 10,00")).toBeTruthy();
  });

  it("AC-1: sem data, não desenha o separador", () => {
    const { container } = render(<NotaFiscal number="1234" bottom="x" />);
    expect(container.textContent).toBe("NF 1234x");
  });

  it("AC-2: sem onOpen, o número tem o mesmo estilo e não é botão", () => {
    render(<NotaFiscal number="77" bottom="x" />);
    expect(screen.queryByRole("button")).toBeNull();
    const numberText = screen.getByText("NF 77");
    expect(numberText.style.color).toBe("var(--content-brand)");
    expect(numberText.style.textDecoration).toBe("underline");
  });

  it("AC-2: com onOpen, é botão rotulado e o clique não chega à linha", () => {
    const onOpen = vi.fn();
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <NotaFiscal number="77" onOpen={onOpen} openLabel="Abrir a nota 77" />
      </div>,
    );
    const button = screen.getByRole("button", { name: "Abrir a nota 77" });
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRow).not.toHaveBeenCalled();
  });

  it("AC-1: aceita um prefixo antes do número", () => {
    render(<NotaFiscal number="9" prefix={<span aria-label="sem permissão" role="img">🔒</span>} />);
    expect(screen.getByRole("img", { name: "sem permissão" })).toBeTruthy();
  });
});
