// #211 Uma carga só de `GET /api/automacao` por tela, entregue à faixa e aos indicadores.
// #357 `reload` carrega de novo (depois de "Rodar agora" ou de mudar o modo) sem apagar a faixa enquanto a resposta nova não chega.
import { createContext, useContext, useRef, type ReactNode } from "react";
import { loadAutomation, type AutomationDto } from "../api/automation";
import { useLoad, type Load } from "./useLoad";

interface AutomationValue {
  load: Load<AutomationDto>;
  /** A última carga pronta: fica na tela enquanto a recarga corre. */
  kept: AutomationDto | undefined;
}

const AutomationContext = createContext<AutomationValue | null>(null);

export function AutomationProvider({
  load = loadAutomation,
  children,
}: {
  load?: (signal: AbortSignal) => Promise<AutomationDto>;
  children: ReactNode;
}) {
  // A faixa e os indicadores são informação a mais: esperam a carga da própria tela sair primeiro,
  // para nunca ficarem na frente dela.
  const value = useLoad(async (signal) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return load(signal);
  });
  const kept = useRef<AutomationDto | undefined>(undefined);
  if (value.state === "ready" && value.data) kept.current = value.data;
  return <AutomationContext.Provider value={{ load: value, kept: value.state === "loading" ? kept.current : undefined }}>{children}</AutomationContext.Provider>;
}

/** A automação carregada, ou nulo fora do provider, antes de chegar e quando a carga falhou ou veio fora do formato. */
export function useAutomation(): AutomationDto | null {
  const ctx = useContext(AutomationContext);
  const data = ctx?.load.state === "ready" ? ctx.load.data : ctx?.kept;
  if (!data || !["ok", "failed", "stalled"].includes(data.state) || !data.indicators) return null;
  return data;
}

/** #357 Carrega a automação de novo; sem efeito fora do provider. */
export function useAutomationReload(): () => void {
  const ctx = useContext(AutomationContext);
  return ctx?.load.retry ?? (() => {});
}
