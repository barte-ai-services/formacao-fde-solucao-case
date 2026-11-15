// O jsdom não tem matchMedia nem ResizeObserver, que a moldura e os gráficos do ui-kit usam.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// O jsdom não rola a janela: navegar chama scrollTo.
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});
