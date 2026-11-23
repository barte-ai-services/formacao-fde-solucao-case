import { useEffect } from "react";
import { ShellFrame, type ShellContext } from "@barte-ai-services/shell-kit";
import { LoadFeedback } from "@barte-ai-services/barte-ui-kit";
import { AutomationProvider } from "./components/automation-context";
import { AutomationBand } from "./components/AutomationBand";
import { NotFound } from "./components/NotFound";
import { ERROR_DESCRIPTION, RETRY_LABEL } from "./components/Screen";
import { useLoad } from "./components/useLoad";
import { matchRoute, navigate, usePathname } from "./router";
import { REDIRECTS, ROUTES } from "./routes";
import { loadShellContext, ZONE } from "./shell/context";
import { ViewerProvider } from "./shell/viewer";
import { texts } from "./texts";

/** A rota do caminho atual, na moldura. `/` leva à fila; caminho desconhecido, "Página não encontrada". */
function CurrentRoute() {
  const pathname = usePathname();
  const redirect = Object.hasOwn(REDIRECTS, pathname) ? REDIRECTS[pathname] : undefined;
  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect]);
  if (redirect) return null;
  const matched = matchRoute(ROUTES, pathname);
  if (!matched) return <NotFound />;
  const Route = matched.route.component;
  return <Route key={pathname} params={matched.params} />;
}

export function Frame({ context }: { context: ShellContext }) {
  useEffect(() => {
    document.documentElement.dataset.theme = context.theme;
  }, [context.theme]);
  return (
    <ShellFrame context={context} zone={ZONE}>
      <ViewerProvider email={context.user?.email ?? null}>
        <AutomationProvider>
          {/* #372 A faixa e a tela dividem o mesmo contêiner das telas: a largura e o respiro até o título vêm dele. */}
          <div className="shell-home">
            <AutomationBand />
            <CurrentRoute />
          </div>
        </AutomationProvider>
      </ViewerProvider>
    </ShellFrame>
  );
}

export function App({ loadContext = loadShellContext }: { loadContext?: () => Promise<ShellContext> }) {
  const { state, data, retry } = useLoad(() => loadContext());
  if (state !== "ready" || !data) {
    // Enquanto o contexto chega, o carregando de página, e não uma tela branca.
    return (
      <LoadFeedback
        state={state === "ready" ? "loading" : state}
        size="page"
        loadingLabel={texts.app.loading}
        errorTitle={texts.app.error}
        errorDescription={ERROR_DESCRIPTION}
        retryLabel={RETRY_LABEL}
        onRetry={retry}
      />
    );
  }
  return <Frame context={data} />;
}
