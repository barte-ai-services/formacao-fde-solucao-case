import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";

/**
 * /pagar/fila/:id: a proposta de uma nota. No wireframe ela abre como gaveta da fila; aqui é uma
 * rota própria, para ter endereço. A história decide se a fila a mostra como gaveta por cima.
 */
export default function Proposta({ params }: RouteProps) {
  const id = params.id ?? "";
  // A história troca esta carga por um `apiGet` da proposta e desenha a evidência com <EvidenceView>.
  const { state, retry } = useLoad(async (): Promise<unknown[]> => [], (rows) => rows.length === 0);
  return (
    <Screen
      title={`Proposta da nota ${id}`}
      subtitle="A ação na doca proposta pelo agente, a evidência por divergência e a sua decisão."
      state={state}
      onRetry={retry}
      loadingLabel="Carregando a proposta…"
      errorTitle="Não consegui ler esta proposta agora"
      emptyLabel="Esta proposta ainda não chegou. Ela aparece aqui assim que o agente conferir a nota."
    />
  );
}
