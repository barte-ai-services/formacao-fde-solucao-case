import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccessKey } from "./AccessKey";

const KEY = "35261100000000000000550010000080001000080001";

describe("#129 AccessKey", () => {
  it("mostra a chave inteira numa linha e o botão copia a chave", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<AccessKey value={KEY} />);
    expect(screen.getByText(KEY).className).toContain("pagar-access-key__value");
    fireEvent.click(screen.getByRole("button", { name: "Copiar chave" }));
    expect(writeText).toHaveBeenCalledWith(KEY);
  });
});
