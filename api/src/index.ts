import { tick } from "./cron/tick";
import type { Env } from "./env";
import { createAccessVerifier, fetchJwksOverNetwork } from "./http/access";
import { route, type RouterDeps } from "./http/router";

/** Monta o Worker com as dependências dadas. Os testes injetam um verificador sem rede (#54). */
export function createWorker(deps: RouterDeps) {
  return {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
      return route(request, env, deps);
    },
    async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
      await tick(controller, env);
    },
  } satisfies ExportedHandler<Env>;
}

// O verificador vive no escopo do módulo, então o cache das chaves do Access dura o isolate.
export default createWorker({ verifier: createAccessVerifier(fetchJwksOverNetwork) });
