/**
 * O stand-in de `next/navigation` para a tela. O shell-kit é feito para zones em Next e pede
 * `usePathname` e `useRouter().push`; aqui não há Next, então os dois vivem em cima da History API
 * de verdade: `pushState` muda o endereço sem recarregar, e o voltar do navegador (`popstate`)
 * avisa quem está ouvindo.
 */
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

function currentPath(): string {
  return window.location.pathname;
}

/** Vai para `href` sem recarregar a página. `replace` troca a entrada do histórico em vez de somar. */
export function navigate(href: string, options: { replace?: boolean } = {}) {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href);
    return;
  }
  const target = `${url.pathname}${url.search}${url.hash}`;
  if (options.replace) window.history.replaceState(null, "", target);
  else window.history.pushState(null, "", target);
  notify();
  if (!options.replace) window.scrollTo?.(0, 0);
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, currentPath, () => "/");
}

export interface AppRouter {
  push(href: string): void;
  replace(href: string): void;
  back(): void;
  forward(): void;
  refresh(): void;
  prefetch(href: string): void;
}

const router: AppRouter = {
  push: (href) => navigate(href),
  replace: (href) => navigate(href, { replace: true }),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  // Sem servidor de componentes para refazer: avisar quem ouve basta para a tela reler o caminho.
  refresh: () => notify(),
  // Tudo já está no pacote: não há o que buscar antes.
  prefetch: () => undefined,
};

export function useRouter(): AppRouter {
  return router;
}

/** Como no Next: interrompe a renderização. Aqui, quem decide o "não encontrada" é a tabela de rotas. */
export function notFound(): never {
  throw new Error("Página não encontrada");
}
