import type { ReactElement, ReactNode } from "react";
import { Drawer } from "barte-design-system";
import { InlineEmpty } from "@barte-ai-services/barte-ui-kit";
import { ApiError } from "../api/client";
import { supplierRequestApi } from "../api/supplier-request";
import { approvalApi, type DecisionResultDto, type ProposalDetailDto } from "../api/approval";
import { useLoad } from "../components/useLoad";
import { useViewer } from "../shell/viewer";
import { texts } from "../texts";
import { ProposalPanel } from "./ProposalPanel";

/**
 * #209 A gaveta da nota, uma só para toda grid: a proposta (`ProposalPanel`) da chave de acesso da linha.
 * Antes da decisão traz o formulário; depois, só a decisão registrada. O que cada tela precisa mostrar a mais
 * (a duplicada, a devolução, a ação na doca) entra em `children`, acima da proposta.
 */
export function InvoiceDrawer({
  invoiceAccessKey,
  title,
  onClose,
  onDecided,
  children,
}: {
  invoiceAccessKey: string;
  /** O título depende do número da nota, que só a tela ou a proposta conhecem. */
  title: (number: string | null) => string;
  onClose: () => void;
  onDecided?: (result: DecisionResultDto) => void;
  children?: ReactNode;
}): ReactElement {
  const viewer = useViewer();
  const { state, data, error } = useLoad((signal): Promise<ProposalDetailDto> => approvalApi.proposal(invoiceAccessKey, signal));
  return (
    <Drawer isOpen title={title(data ? data.number : null)} onClose={onClose} className="shell-connection-panel">
      {children !== undefined ? <div style={{ padding: "var(--spacing-lg)" }}>{children}</div> : null}
      {state === "ready" && data ? (
        <ProposalPanel proposal={data} onDecided={onDecided} supplierRequest={{ port: supplierRequestApi, viewer }} />
      ) : (
        <InlineEmpty>{state === "error" ? (error instanceof ApiError && error.status === 404 ? texts.fila.noProposal : texts.fila.drawerError) : texts.fila.drawerLoading}</InlineEmpty>
      )}
    </Drawer>
  );
}
