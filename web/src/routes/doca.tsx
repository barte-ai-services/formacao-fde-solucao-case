import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";

/** /doca: a doca, para quem recebe a carga. */
export default function Doca(_props: RouteProps) {
  // A história troca esta carga por um `apiGet` do endpoint dela, sob `/api/...`, e desenha as linhas.
  const { state, retry } = useLoad(async (): Promise<unknown[]> => [], (rows) => rows.length === 0);
  return (
    <Screen
      title="Doca"
      subtitle="As notas que chegam hoje neste destino e o que fazer com cada caminhão. Nada é descarregado antes da decisão."
      state={state}
      onRetry={retry}
      loadingLabel="Carregando as notas da doca…"
      errorTitle="Não consegui ler as notas desta doca agora"
      emptyLabel="Nenhuma nota com entrega prevista hoje neste destino."
    />
  );
}
