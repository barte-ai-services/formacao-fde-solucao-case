import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "barte-design-system/styles";
import { ToastProvider } from "barte-design-system";
import { ShellFrame, type ShellContext } from "@barte-ai-services/shell-kit";
import "@barte-ai-services/shell-kit/styles.css";
import { SegmentedFilter, type LoadState } from "@barte-ai-services/barte-ui-kit";
import { usePathname } from "./next-navigation";
import { Doca, FilaDeAprovacao, ListaDoDia, NotasDuplicadas, ValorBarrado } from "./screens";
import "./app.css";

/** O contexto que o Shell entregaria à zone do contas a pagar. A Já Chegou é fictícia. */
const CONTEXT: ShellContext = {
  version: 1,
  user: { id: "u-1", name: "Marina Prado", email: "marina.prado@exemplo.com", roles: ["coordenacao"] },
  brand: { name: "Já Chegou", product: "Contas a pagar", logo: null },
  navigation: [
    {
      key: "pagar",
      label: "Contas a pagar",
      items: [
        { key: "fila", label: "Fila de aprovação", href: "/pagar/fila", zone: "pagar", icon: "list-checks" },
        { key: "hoje", label: "Lista do dia", href: "/pagar/hoje", zone: "pagar", icon: "calendar" },
        { key: "duplicadas", label: "Notas duplicadas", href: "/pagar/duplicadas", zone: "pagar", icon: "receipt" },
        { key: "barrado", label: "Valor barrado", href: "/pagar/valor-barrado", zone: "pagar", icon: "chart-bar" },
      ],
    },
    {
      key: "recebimento",
      label: "Recebimento",
      items: [{ key: "doca", label: "Doca", href: "/doca", zone: "pagar", icon: "truck" }],
    },
  ],
  account_menu: [],
  administration: [],
  home: "/pagar/fila",
  theme: "light",
  account: null,
  sidebar: "expanded",
};

const SCREENS: Record<string, { label: string; render: (state: LoadState, aprovadas: boolean) => JSX.Element; nota: string }> = {
  "/pagar/fila": {
    label: "Fila de aprovação",
    render: (state, aprovadas) => <FilaDeAprovacao state={state} aprovadas={aprovadas} />,
    nota: "Clique numa linha para abrir a proposta (#32, #38).",
  },
  "/pagar/hoje": { label: "Lista do dia", render: (state, aprovadas) => <ListaDoDia state={state} aprovadas={aprovadas} />, nota: "Todas as notas de hoje (#32)." },
  "/pagar/duplicadas": {
    label: "Notas duplicadas",
    render: (state, aprovadas) => <NotasDuplicadas state={state} aprovadas={aprovadas} />,
    nota: "Clique numa linha para ver a duplicada ao lado da original (#31).",
  },
  "/pagar/valor-barrado": {
    label: "Valor barrado",
    render: (state, aprovadas) => <ValorBarrado state={state} aprovadas={aprovadas} />,
    nota: "O mês contra os R$ 543 mil (#39).",
  },
  "/doca": {
    label: "Doca",
    render: (state, aprovadas) => <Doca state={state} aprovadas={aprovadas} />,
    nota: "Quem opera a doca vê só este item no menu (#43).",
  },
};

const STATES: { value: LoadState; label: string }[] = [
  { value: "ready", label: "Com dados" },
  { value: "empty", label: "Vazio" },
  { value: "error", label: "Erro" },
  { value: "loading", label: "Carregando" },
];

function App() {
  const path = usePathname();
  const [state, setState] = useState<LoadState>("ready");
  const [cenario, setCenario] = useState<"antes" | "depois">("antes");
  const screen = SCREENS[path] ?? SCREENS["/pagar/fila"]!;
  return (
    <>
      <ShellFrame context={CONTEXT} zone="pagar">
        {screen.render(state, cenario === "depois")}
      </ShellFrame>
      <div className="wf-controls" role="region" aria-label="Controles do wireframe">
        <span className="wf-controls-title">Wireframe · {screen.label}</span>
        <SegmentedFilter<LoadState> size="sm" ariaLabel="Estado da tela" options={STATES} value={state} onChange={setState} />
        <SegmentedFilter<"antes" | "depois">
          size="sm"
          ariaLabel="Cenário das propostas"
          options={[
            { value: "antes", label: "Antes de aprovar" },
            { value: "depois", label: "Após aprovar" },
          ]}
          value={cenario}
          onChange={setCenario}
        />
        <span className="wf-controls-note">{screen.nota} Todo número vem do kit: as propostas são as do gabarito; "após aprovar" é cada uma aprovada como o agente propôs.</span>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>
);
