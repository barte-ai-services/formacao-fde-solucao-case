import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "barte-design-system/styles";
import "@barte-ai-services/barte-ui-kit/styles";
import { Alert, ToastProvider } from "barte-design-system";
import { ShellFrame, type ShellContext } from "@barte-ai-services/shell-kit";
import "@barte-ai-services/shell-kit/styles.css";
import { SegmentedFilter } from "@barte-ai-services/barte-ui-kit";
import "@portal/app.css";
import "./wf.css";
import { navigate, usePathname } from "./next-navigation";
import { AGG_FILA, AGG_HOJE, BLOCK, FILA, FILA_MINE, HOJE, type FilaRow, type HojeRow } from "./data";
import { FilaScreen, HojeScreen, OutrasScreen, type Filter, type View } from "./screens";
import { FluxoScreen } from "./fluxo";
import type { Phase } from "./scroll-table";

/** #160 O contexto que o Shell entregaria à zone. É o mesmo do portal (web/src/shell/context.ts). A Já Chegou é fictícia. */
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
        { key: "barrado", label: "Pagamento errado evitado", href: "/pagar/valor-barrado", zone: "pagar", icon: "chart-bar" },
      ],
    },
    {
      key: "recebimento",
      label: "Recebimento",
      items: [
        { key: "doca", label: "Doca (CD)", href: "/doca", zone: "pagar", icon: "truck" },
        { key: "loja", label: "Loja", href: "/recebimento/loja", zone: "pagar", icon: "buildings" },
      ],
    },
  ],
  account_menu: [],
  administration: [],
  home: "/pagar/fila",
  theme: "light",
  account: null,
  sidebar: "expanded",
};

type St = "live" | "loading" | "rolando" | "proximo" | "fim" | "vazio" | "erro" | "erro-bloco" | "filtro" | "cursor" | "foco";
const STATES: { value: St; label: string }[] = [
  { value: "rolando", label: "2. Lista rolando (cabeçalho fixo)" },
  { value: "live", label: "Ao vivo: role a tabela (1, 2, 3, 4 e 7)" },
  { value: "loading", label: "1. Primeira carga" },
  { value: "proximo", label: "3. Carregando o próximo bloco" },
  { value: "fim", label: "4. Fim da lista" },
  { value: "vazio", label: "5. Lista vazia" },
  { value: "erro", label: "6. Erro na primeira carga" },
  { value: "erro-bloco", label: "7. Erro ao buscar um bloco do meio" },
  { value: "filtro", label: "8. Filtro aplicado: volta ao topo e recarrega" },
  { value: "cursor", label: "8b. Filtro: cursor_invalido" },
  { value: "foco", label: "9. Linha focada e gaveta aberta (#209)" },
];

const NOTES: Record<St, { what: string; ac: string }> = {
  live: { what: "Funciona de verdade: role a tabela até perto do fim. Pede um bloco de 30 (esqueleto por 0,9 s). O terceiro bloco falha uma vez, para você ver o erro e o “Tentar de novo”. Trocar o filtro recomeça.", ac: "AC-1, AC-3" },
  loading: { what: "A primeira carga é a de hoje: spinner da tela. Ainda não há contador nem números do topo.", ac: "AC-1" },
  rolando: { what: "60 de 132 carregadas, a caixa rolada: o cabeçalho continua no topo. O contador (“132 notas”) e os números do topo vêm de total e aggregates, não de quantas linhas carregaram.", ac: "AC-2, AC-3, AC-4" },
  proximo: { what: "Chegou perto do fim e há nextCursor: três linhas de esqueleto abaixo da última nota. As 60 carregadas ficam, e nenhum número do topo muda.", ac: "AC-1, AC-4" },
  fim: { what: "O nextCursor veio nulo: o rodapé diz “Você viu todas as 132 notas” e nada mais é pedido.", ac: "AC-3" },
  vazio: { what: "O EmptyState de hoje, sem tabela e sem contador. É o que se vê quando o total é zero.", ac: "AC-3" },
  erro: { what: "A falha da primeira carga é a de hoje: erro da tela e “Tentar de novo”, que volta ao estado 1.", ac: "AC-1" },
  "erro-bloco": { what: "O bloco do meio falhou. A faixa fica abaixo da última linha e as 60 que carregaram continuam; “Tentar de novo” pede o mesmo cursor. Os números do topo não mudam.", ac: "AC-1, AC-4" },
  filtro: { what: "A pessoa trocou o filtro: a caixa volta ao topo e a lista esvazia e recarrega do início, com esqueleto. O contador diz “Carregando…” e os números do topo ficam.", ac: "AC-1, AC-4" },
  cursor: { what: "A API respondeu 400 cursor_invalido (o cursor era de outro filtro). A tela recomeça do início, uma vez, e avisa numa linha. D4: a alternativa é recomeçar sem avisar.", ac: "AC-1" },
  foco: { what: "Tab chegou à 5ª linha (realce igual ao do mouse) e Enter abriu a gaveta, como na #209. Linhas de esqueleto nunca ficam no Tab nem abrem gaveta. Fechar devolve o foco à linha.", ac: "#209" },
};

/** #160 A carga ao vivo: blocos de BLOCK, esqueleto enquanto vem, uma falha no terceiro bloco. Não é código de produção. */
function useLive<T extends { key: string }>(all: T[], enabled: boolean): { first: "loading" | "ready"; rows: T[]; phase: Phase; nearEnd: () => void; retry: () => void } {
  const [rows, setRows] = useState<T[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [first, setFirst] = useState<"loading" | "ready">("loading");
  const failed = useRef(false);
  const timer = useRef<number>(0);
  useEffect(() => {
    if (!enabled) return;
    window.clearTimeout(timer.current);
    failed.current = false;
    setRows([]); setPhase("idle"); setFirst("loading");
    timer.current = window.setTimeout(() => {
      setRows(all.slice(0, BLOCK)); setFirst("ready"); setPhase(all.length <= BLOCK ? "end" : "idle");
    }, 700);
    return () => window.clearTimeout(timer.current);
  }, [all, enabled]);
  const nearEnd = useCallback(() => {
    if (phase !== "idle" || rows.length >= all.length) return;
    setPhase("loading-next");
    timer.current = window.setTimeout(() => {
      if (!failed.current && rows.length === 2 * BLOCK) { failed.current = true; setPhase("error-next"); return; }
      const next = all.slice(0, rows.length + BLOCK);
      setRows(next); setPhase(next.length >= all.length ? "end" : "idle");
    }, 900);
  }, [phase, rows, all]);
  const retry = useCallback(() => setPhase("idle"), []);
  return { first, rows, phase, nearEnd, retry };
}

function staticView<T extends { key: string }>(st: Exclude<St, "live">, all: T[], total: number, closed: boolean): View<T> {
  const base: View<T> = {
    load: "ready", rows: all.slice(0, 2 * BLOCK), total, phase: "idle", scroll: "middle", skeletonRows: 3, counterBusy: false,
    showLoaded: true, focusedKey: null, drawerKey: null, notice: null, live: false, retry: () => undefined,
  };
  switch (st) {
    case "loading": return { ...base, load: "loading", rows: [] };
    case "vazio": return { ...base, load: "empty", rows: [], total: 0 };
    case "erro": return { ...base, load: "error", rows: [] };
    case "proximo": return { ...base, phase: "loading-next", scroll: "bottom" };
    case "fim": return { ...base, rows: all, phase: "end", scroll: "bottom", showLoaded: false };
    case "erro-bloco": return { ...base, phase: "error-next", scroll: "bottom" };
    case "filtro": return { ...base, rows: [], phase: "loading-next", skeletonRows: 8, scroll: "top", counterBusy: true, showLoaded: false };
    case "cursor":
      return {
        ...base, rows: all.slice(0, BLOCK), scroll: "top",
        notice: <Alert variant="info" title="A lista mudou e voltou ao início" description="O filtro mudou enquanto o próximo bloco era pedido (cursor_invalido). Recomeçamos do início; nada que você decidiu se perdeu." />,
      };
    case "foco": {
      const row = base.rows[4];
      return { ...base, rows: all.slice(0, BLOCK), scroll: "top" as const, focusedKey: row?.key ?? null, drawerKey: closed ? null : (row?.key ?? null) };
    }
    default: return base;
  }
}

function useView<T extends { key: string }>(st: St, all: T[], total: number, closed: boolean): View<T> {
  const live = useLive<T>(all, st === "live");
  if (st !== "live") return staticView(st, all, total, closed);
  return {
    load: live.first === "loading" ? "loading" : "ready", rows: live.rows, total, phase: live.phase, scroll: "top", skeletonRows: 3,
    counterBusy: false, showLoaded: true, focusedKey: null, drawerKey: null, notice: null, live: true, nearEnd: live.nearEnd, retry: live.retry,
  };
}

function App() {
  const path = usePathname();
  const [st, setSt] = useState<St>("rolando");
  const [filter, setFilter] = useState<Filter>("all");
  const [closed, setClosed] = useState(false);
  const screen = path === "/wf/fluxo" ? "fluxo" : path === "/pagar/hoje" ? "hoje" : path === "/pagar/fila" || path === "/" ? "fila" : "outras";
  const effective: Filter = st === "filtro" || st === "cursor" ? "mine" : filter;
  const filaAll = effective === "mine" ? FILA_MINE : FILA;
  const filaView = useView<FilaRow>(st, filaAll, filaAll.length, closed);
  const hojeView = useView<HojeRow>(st, HOJE, HOJE.length, closed);
  const chooseState = (next: St) => { setSt(next); setClosed(false); if (next === "filtro" || next === "cursor") setFilter("mine"); else if (next !== "live") setFilter("all"); };
  const onFilter = (f: Filter) => { setFilter(f); if (st !== "live") { setSt(f === "mine" ? "filtro" : "rolando"); setClosed(false); } };
  const note = NOTES[st];
  const onList = screen === "fila" || screen === "hoje";
  const hasFilterNote = screen === "hoje" && (st === "filtro" || st === "cursor");
  return (
    <>
      <ShellFrame context={CONTEXT} zone="pagar">
        <div className="wf-controls" role="region" aria-label="Controles do wireframe">
          <span className="wf-controls-title">Wireframe · tabela com scroll infinito (#160)</span>
          <SegmentedFilter<string>
            size="sm"
            ariaLabel="Tela do wireframe"
            options={[
              { value: "/pagar/fila", label: "Fila" },
              { value: "/pagar/hoje", label: "Lista do dia" },
              { value: "/pagar/duplicadas", label: "Duplicadas e doca" },
              { value: "/wf/fluxo", label: "Fluxo" },
            ]}
            value={screen === "fila" ? "/pagar/fila" : screen === "hoje" ? "/pagar/hoje" : screen === "fluxo" ? "/wf/fluxo" : "/pagar/duplicadas"}
            onChange={navigate}
          />
          {onList ? (
            <label>
              <span className="wf-controls-note">Estado da tela</span>
              <select value={st} onChange={(e) => chooseState(e.target.value as St)} aria-label="Estado da tela">
                {STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
          ) : null}
          
        </div>
        {onList ? (
          <div className="wf-annot" role="note">
            <span className="wf-annot-title">Estado · {STATES.find((s) => s.value === st)?.label} · {note.ac}</span>
            <span>{note.what}{hasFilterNote ? " A lista do dia não tem filtro hoje: este estado vale para a troca de dia, se um dia a tela ganhar seletor." : ""}</span>
            <span>Números do topo (aggregates): fila {AGG_FILA.approvable} aprovam, {AGG_FILA.blocked} bloqueadas; lista do dia {AGG_HOJE.approvedByRule} pela regra. Nenhum muda com os blocos.</span>
          </div>
        ) : null}
        {screen === "fila" ? (
          <FilaScreen v={filaView} filter={effective} onFilter={onFilter} onRetryFirst={() => chooseState("loading")} onDrawerClose={() => setClosed(true)} />
        ) : screen === "hoje" ? (
          <HojeScreen v={hojeView} onRetryFirst={() => chooseState("loading")} onDrawerClose={() => setClosed(true)} />
        ) : screen === "fluxo" ? (
          <FluxoScreen />
        ) : (
          <OutrasScreen />
        )}
      </ShellFrame>
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
