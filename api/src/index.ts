import { tick } from "./cron/tick";
import type { Env } from "./env";
import { route } from "./http/router";

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return route(request);
  },
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await tick(controller, env);
  },
} satisfies ExportedHandler<Env>;
