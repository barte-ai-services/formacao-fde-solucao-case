import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";

/** /pagar/valor-barrado: o painel do valor barrado. */
export default function ValorBarrado(_props: RouteProps) {
  // A história troca esta carga por um `apiGet` do endpoint dela, sob `/api/...`, e desenha as linhas.
  const { state, retry } = useLoad(async (): Promise<unknown[]> => [], (rows) => rows.length === 0);
  return (
    <Screen
      title="Valor barrado"
      subtitle="Quanto a conferência impediu de pagar errado neste mês, contra os R$ 543 mil por mês que a Já Chegou pagava sem a mercadoria."
      state={state}
      onRetry={retry}
      loadingLabel="Somando o valor barrado…"
      errorTitle="Não consegui somar o valor barrado agora"
      emptyLabel="Nada barrado neste mês ainda. O valor aparece aqui assim que a primeira proposta for aprovada."
    />
  );
}
