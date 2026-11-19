import type { ReactElement } from "react";
import { dockApi } from "../api/dock";
import { ReceivingBoard } from "./doca";
import type { RouteProps } from "./types";
import { texts } from "../texts";

/**
 * #135 /recebimento/loja: as notas do dia numa loja e a ação que o app da loja recebeu para cada uma.
 * A loja recebe pelo app, sem doca e sem agenda; o texto não fala de caminhão.
 */
export default function RecebimentoNaLoja(_props: RouteProps): ReactElement {
  return (
    <ReceivingBoard
      title={texts.recebimentoLoja.title}
      subtitle={texts.recebimentoLoja.subtitle}
      load={dockApi.storePage}
      words={texts.recebimentoLoja.words}
      noun={texts.recebimentoLoja.noun}
      emptyIn={texts.recebimentoLoja.emptyIn}
      warning={texts.recebimentoLoja.warning}
    />
  );
}
