// #211 Uma carga só de `GET /api/automacao` por tela, entregue à faixa e aos indicadores.
import { createContext, useContext, type ReactNode } from "react";
import { loadAutomation, type AutomationDto } from "../api/automation";
import { useLoad, type Load } from "./useLoad";

const AutomationContext = createContext<Load<AutomationDto> | null>(null);

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
  return <AutomationContext.Provider value={value}>{children}</AutomationContext.Provider>;
}

/** A automação carregada, ou nulo fora do provider, antes de chegar e quando a carga falhou ou veio fora do formato. */
export function useAutomation(): AutomationDto | null {
  const load = useContext(AutomationContext);
  const data = load?.state === "ready" ? load.data : undefined;
  if (!data || !["ok", "failed", "stalled"].includes(data.state) || !data.indicators) return null;
  return data;
}
