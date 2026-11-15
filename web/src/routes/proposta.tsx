import { ApiError } from "../api/client";
import { approvalApi, type ProposalDetailDto } from "../api/approval";
import { ProposalPanel } from "../approval/ProposalPanel";
import { EmptyState } from "../components/EmptyState";
import { Screen } from "../components/Screen";
import { useLoad } from "../components/useLoad";
import type { RouteProps } from "./types";
import { texts } from "../texts";

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
      title={texts.proposta.title(data?.number ?? id)}
      subtitle={texts.proposta.subtitle}
      state={state}
      onRetry={retry}
      loadingLabel={texts.proposta.loading}
      errorTitle={texts.proposta.error}
      emptyLabel={texts.proposta.empty}
      empty={
        <EmptyState
          title={texts.emptyState.proposta.title}
          description={texts.emptyState.proposta.description}
          action={{ label: texts.emptyState.action, to: "/pagar/fila" }}
        />
      }
    >
      {() => (data ? <ProposalPanel proposal={data} /> : null)}
    </Screen>
  );
}
