import type { ReactNode } from "react";
import { LoadFeedback, PageTitleBar, type LoadState } from "@barte-ai-services/barte-ui-kit";

export const RETRY_LABEL = "Tentar de novo";
export const ERROR_DESCRIPTION = "Tente de novo em um minuto. Se continuar, avise o suporte da Barte.";

export interface ScreenProps {
  title: string;
  subtitle?: string;
  /** Ao lado do título: um filtro, um seletor de destino. */
  actions?: ReactNode;
  state: LoadState;
  loadingLabel: string;
  errorTitle: string;
  emptyLabel: ReactNode;
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
        emptyLabel={emptyLabel}
      >
        {() => <div className="pagar-body">{typeof children === "function" ? children() : children}</div>}
      </LoadFeedback>
    </div>
  );
}
