import { ApiError } from "../api/client";
import { approvalApi, type ProposalDetailDto } from "../api/approval";
import { ProposalPanel } from "../approval/ProposalPanel";
import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";

/**
 * /pagar/fila/:id: a proposta de uma nota, pela chave de acesso. Na fila ela abre como gaveta; aqui
 * tem endereço próprio, para ser aberta por link.
 */
export default function Proposta({ params }: RouteProps) {
  const id = params.id ?? "";
  const { state, data, retry } = useLoad(
    async (signal): Promise<ProposalDetailDto | null> => {
      try {
        return await approvalApi.proposal(id, signal);
      } catch (e) {
        // Nota sem proposta ainda: é o estado vazio, não erro.
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    (p) => p === null,
  );
  return (
    <Screen
      title={`Proposta da nota ${data?.number ?? id}`}
      subtitle="A ação na doca proposta pelo agente, a evidência por divergência e a sua decisão."
      state={state}
      onRetry={retry}
      loadingLabel="Carregando a proposta…"
      errorTitle="Não consegui ler esta proposta agora"
      emptyLabel="Esta proposta ainda não chegou. Ela aparece aqui assim que o agente conferir a nota."
    >
      {() => (data ? <ProposalPanel proposal={data} /> : null)}
    </Screen>
  );
}
