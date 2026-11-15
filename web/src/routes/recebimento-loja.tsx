import { dockApi } from "../api/dock";
import { ReceivingBoard } from "./doca";
import type { RouteProps } from "./types";

/**
 * #135 /recebimento/loja: as notas do dia numa loja e a ação que o app da loja recebeu para cada uma.
 * A loja recebe pelo app, sem doca e sem agenda; o texto não fala de caminhão.
 */
export default function RecebimentoNaLoja(_props: RouteProps) {
  return (
    <ReceivingBoard
      title="Recebimento na loja"
      subtitle="As notas que chegam hoje nesta loja e a ação que o app da loja recebeu para cada uma. Nada é recebido antes da decisão."
      load={(store, signal) => dockApi.storeBoard(store, signal)}
      words={{ receive: "Receba tudo no app", refuse: "Recuse a nota inteira no app", awaiting: "Não receba ainda" }}
      noun="loja"
      emptyIn={(shown) => `Nenhuma nota com entrega prevista hoje ${shown ? `na ${shown}` : "nesta loja"}.`}
      warning="Segure o recebimento: a ação aparece aqui assim que a pessoa decidir."
    />
  );
}
