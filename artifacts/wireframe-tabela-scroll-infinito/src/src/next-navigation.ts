// Stand-in do roteador do Next para o wireframe: a moldura do shell-kit pede usePathname e useRouter.
import { useSyncExternalStore } from "react";

let current = "/pagar/fila";
const listeners = new Set<() => void>();

export function navigate(path: string) {
  current = path;
  listeners.forEach((listener) => listener());
  window.scrollTo(0, 0);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

export function useRouter() {
  return { push: navigate, replace: navigate, back: () => undefined, refresh: () => undefined, prefetch: () => undefined };
}

export function notFound(): never {
  throw new Error("not found");
}
