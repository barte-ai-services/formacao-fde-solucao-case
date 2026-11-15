import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";

/** /pagar/duplicadas: as notas duplicadas. */
export default function NotasDuplicadas(_props: RouteProps) {
  // A história troca esta carga por um `apiGet` do endpoint dela, sob `/api/...`, e desenha as linhas.
  const { state, retry } = useLoad(async (): Promise<unknown[]> => [], (rows) => rows.length === 0);
  return (
    <Screen
      title="Notas duplicadas"
      subtitle="Cada nota que cobra uma compra já cobrada, ao lado da original. O título fica bloqueado: ninguém paga até a coordenação resolver."
      state={state}
      onRetry={retry}
      loadingLabel="Procurando duplicidades…"
      errorTitle="Não consegui ler as duplicidades agora"
      emptyLabel="Nenhuma nota duplicada neste mês. Quando uma nota cobrar uma compra já cobrada, ela aparece aqui, bloqueada."
    />
  );
}
