import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";

const DAY = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long" });

/** /pagar/hoje: a lista do dia. */
export default function ListaDoDia(_props: RouteProps) {
  // A história troca esta carga por um `apiGet` do endpoint dela, sob `/api/...`, e desenha as linhas.
  const { state, retry } = useLoad(async (): Promise<unknown[]> => [], (rows) => rows.length === 0);
  return (
    <Screen
      title="Lista do dia"
      subtitle={`Todas as notas fiscais que chegaram hoje, ${DAY.format(new Date())}, com a proposta e a situação de cada uma.`}
      state={state}
      onRetry={retry}
      loadingLabel="Carregando as notas do dia…"
      errorTitle="Não consegui ler as notas de hoje agora"
      emptyLabel="Nenhuma nota fiscal chegou hoje. As notas aparecem aqui quando o conector da SEFAZ as recebe."
    />
  );
}
