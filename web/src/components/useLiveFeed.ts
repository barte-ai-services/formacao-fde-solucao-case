import { useCallback, useEffect, useState } from "react";
import type { LoadState } from "@barte-ai-services/barte-ui-kit";
import { liveApi } from "../api/live";
import { mergeFeed, startFeed, type LiveFeed } from "./live-state";

/** #355 De quanto em quanto tempo a tela pergunta pelos passos novos: dentro do teto de 10 s do AC-2, com folga para a latência. */
export const POLL_MS = 5_000;

type Model =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; feed: LiveFeed; /** #355 O último pedido de atualização falhou: a lista fica e o cursor não anda. */ stale: boolean };

type Publish = (update: (model: Model) => Model) => void;

/** #355 Espera `ms`; resolve `false` se a tela saiu antes, e o laço para. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve(!signal.aborted);
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * #355 A primeira carga e depois um pedido por vez a cada `POLL_MS`: o próximo só é marcado quando o anterior terminou, então nunca há dois em voo.
 * Uma falha da primeira carga é o erro da tela; uma falha depois dela só marca `stale`, e o mesmo cursor vai no pedido seguinte.
 * Nunca rejeita: o chamador pode soltá-la com `void`. O texto de um erro não sai daqui, só o fato de ter falhado.
 */
async function follow(signal: AbortSignal, publish: Publish): Promise<void> {
  publish(() => ({ phase: "loading" }));
  let feed: LiveFeed;
  try {
    feed = startFeed(await liveApi.load(null, signal));
  } catch {
    if (!signal.aborted) publish(() => ({ phase: "error" }));
    return;
  }
  // #355 O atualizador roda depois, na renderização: ele lê uma constante, não o `feed` que o laço ainda vai trocar.
  const first = feed;
  publish(() => ({ phase: "ready", feed: first, stale: false }));
  while (await wait(POLL_MS, signal)) {
    try {
      const next = mergeFeed(feed, await liveApi.load(feed.since, signal));
      feed = next;
      publish(() => ({ phase: "ready", feed: next, stale: false }));
    } catch {
      if (signal.aborted) return;
      publish((model) => (model.phase === "ready" ? { ...model, stale: true } : model));
    }
  }
}

export interface LiveView {
  state: LoadState;
  feed: LiveFeed | undefined;
  stale: boolean;
  retry: () => void;
}

/** #355 Os passos da automação: carrega ao montar, se atualiza sozinho e para ao sair da tela. */
export function useLiveFeed(): LiveView {
  const [attempt, setAttempt] = useState(0);
  const [model, setModel] = useState<Model>({ phase: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void follow(controller.signal, (update) => {
      if (!controller.signal.aborted) setModel(update);
    });
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (model.phase !== "ready") return { state: model.phase, feed: undefined, stale: false, retry };
  return { state: model.feed.rows.length === 0 ? "empty" : "ready", feed: model.feed, stale: model.stale, retry };
}
