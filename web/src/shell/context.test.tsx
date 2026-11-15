import { ShellIcon } from "@barte-ai-services/shell-kit";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NAVIGATION } from "./context";

// #135 O Shell só desenha o ícone que está no registro dele; o nome que falta deixa o item sem ícone.
describe("#135 ícones do menu", () => {
  it("todo item do menu tem um ícone que o Shell desenha", () => {
    for (const group of NAVIGATION) {
      for (const item of group.items) {
        const { container, unmount } = render(<ShellIcon name={item.icon} />);
        expect(container.firstElementChild, `${item.label} (${item.icon})`).not.toBeNull();
        unmount();
      }
    }
  });
});
