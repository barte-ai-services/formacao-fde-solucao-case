import type { ReactNode } from "react";
import { LoadFeedback, PageTitleBar, type LoadState } from "@barte-ai-services/barte-ui-kit";
import { texts } from "../texts";

export const RETRY_LABEL = texts.common.retry;
export const ERROR_DESCRIPTION = texts.common.errorDescription;

export interface ScreenProps {
  title: string;
  subtitle?: string;
  /** Ao lado do título: um filtro, um seletor de destino. */
  actions?: ReactNode;
  state: LoadState;
  loadingLabel: string;
  errorTitle: string;
  emptyLabel: ReactNode;
  /** O vazio com ilustração, título e ação (`EmptyState`); no lugar do `emptyLabel` quando a carga vem vazia. */
  empty?: ReactNode;
  /** O "Tentar de novo" do erro. Normalmente o `retry` do `useLoad`. */
  onRetry: () => void;
  children?: ReactNode | (() => ReactNode);
}

/**
 * A casca de toda tela, a mesma do wireframe aprovado (F3): título compacto e o estado da carga,
 * como em Sessões ativas e Conexões, no Shell. O conteúdo só aparece em `ready`.
 */
export function Screen({
  title,
  subtitle,
  actions,
  state,
  loadingLabel,
  errorTitle,
  emptyLabel,
  empty,
  onRetry,
  children,
}: ScreenProps) {
  return (
    <div className="shell-home pagar-screen">
      <PageTitleBar variant="compact" title={title} subtitle={subtitle} actions={actions} />
      <LoadFeedback
        state={state}
        size="page"
        loadingLabel={loadingLabel}
        errorTitle={errorTitle}
        errorDescription={ERROR_DESCRIPTION}
        retryLabel={RETRY_LABEL}
        onRetry={onRetry}
        emptyLabel={state === "empty" && empty ? empty : emptyLabel}
      >
        {() => <div className="pagar-body">{typeof children === "function" ? children() : children}</div>}
      </LoadFeedback>
    </div>
  );
}
