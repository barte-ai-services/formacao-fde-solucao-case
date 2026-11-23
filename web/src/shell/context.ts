import { CONTEXT_VERSION, type NavGroup, type ShellContext } from "@barte-ai-services/shell-kit";
import { fetchShellContext } from "@barte-ai-services/shell-kit/server";
import { me } from "../api/client";
import { HOME } from "../routes";

/** A zone desta tela no Shell. */
export const ZONE = "pagar";

/** O menu do contas a pagar, como no wireframe aprovado (F3). */
export const NAVIGATION: NavGroup[] = [
  {
    key: "pagar",
    label: "Contas a pagar",
    items: [
      { key: "fila", label: "Fila de aprovação", href: "/pagar/fila", zone: ZONE, icon: "list-checks" },
      { key: "hoje", label: "Lista do dia", href: "/pagar/hoje", zone: ZONE, icon: "calendar" },
      { key: "duplicadas", label: "Notas duplicadas", href: "/pagar/duplicadas", zone: ZONE, icon: "receipt" },
      { key: "barrado", label: "Pagamento errado evitado", href: "/pagar/valor-barrado", zone: ZONE, icon: "chart-bar" },
      { key: "ao-vivo", label: "Ao vivo", href: "/pagar/ao-vivo", zone: ZONE, icon: "flow-arrow" }, // ADR-004
      { key: "pedidos-fornecedor", label: "Pedidos ao fornecedor", href: "/pedidos-fornecedor", zone: ZONE, icon: "receipt" }, // ADR-004
    ],
  },
  {
    key: "recebimento",
    label: "Recebimento",
    items: [
      { key: "doca", label: "Doca (CD)", href: "/doca", zone: ZONE, icon: "truck" },
      { key: "loja", label: "Loja", href: "/recebimento/loja", zone: ZONE, icon: "buildings" },
      { key: "devolucoes", label: "Notas de devolução", href: "/devolucoes", zone: ZONE, icon: "receipt" },
    ],
  },
];

/** O contexto fixo, quando não há Shell para perguntar. A Já Chegou é fictícia. */
export function fallbackContext(email: string | null): ShellContext {
  return {
    version: CONTEXT_VERSION,
    user: { id: email ?? "anonimo", name: email ?? "Pessoa da Já Chegou", email, roles: ["coordenacao"] },
    brand: { name: "Já Chegou", product: "Contas a pagar", logo: null },
    navigation: NAVIGATION,
    account_menu: [],
    administration: [],
    home: HOME,
    theme: "light",
    account: null,
    sidebar: "expanded",
  };
}

async function emailFromWorker(): Promise<string | null> {
  try {
    return (await me()).email;
  } catch {
    return null;
  }
}

/**
 * O contexto da moldura. Com `VITE_SHELL_URL`, pede ao Shell (no navegador, o cabeçalho de cookie é
 * ignorado). Sem ele, ou se o Shell falhar, monta o contexto fixo com o e-mail que o `GET /me` do
 * Worker devolver.
 */
export async function loadShellContext(shellUrl: string | undefined = import.meta.env.VITE_SHELL_URL): Promise<ShellContext> {
  if (shellUrl) {
    try {
      return await fetchShellContext({ shellUrl, cookie: "" });
    } catch {
      // Cai no contexto fixo: a tela abre mesmo sem o Shell.
    }
  }
  return fallbackContext(await emailFromWorker());
}
