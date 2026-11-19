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

// #160 A tabela das listas por blocos observa uma marca no fim da caixa: o jsdom não tem IntersectionObserver, e o teste que quer o aviso o simula (web/test/tabela-scroll-infinito.test.tsx).
if (!("IntersectionObserver" in globalThis)) {
  // #160 Só o que a tabela usa (observe e disconnect); o resto da interface não é lido.
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  } as unknown as typeof IntersectionObserver; // #160 o simulado só tem o que a tabela chama; o resto da interface real não é lido
}

// O jsdom não rola a janela: navegar chama scrollTo.
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});
