import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";

/** /pagar/fila: a fila de aprovação. */
export default function FilaDeAprovacao(_props: RouteProps) {
  // A história troca esta carga por um `apiGet` do endpoint dela, sob `/api/...`, e desenha as linhas.
  const { state, retry } = useLoad(async (): Promise<unknown[]> => [], (rows) => rows.length === 0);
  return (
    <Screen
      title="Fila de aprovação"
      subtitle="As propostas do agente que esperam uma pessoa decidir. O nível mais alto e o maior valor em risco vêm primeiro."
      state={state}
      onRetry={retry}
      loadingLabel="Carregando a fila…"
      errorTitle="Não consegui ler a fila de aprovação agora"
      emptyLabel="Nenhuma proposta esperando você. As novas aparecem aqui assim que o agente conferir a nota."
    />
  );
}
