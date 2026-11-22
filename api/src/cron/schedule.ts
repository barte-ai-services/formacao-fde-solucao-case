// #333 O despacho do `scheduled` pelo `controller.cron`: o Worker tem três cron triggers (api/wrangler.jsonc), cada um com o próprio teto de 50 subrequests (#311 o terceiro é o do dossiê).
import { runAuditRound } from "../claude/cron";
import { supabaseConnectors } from "../connectors/supabase-connectors";
import { SupabaseRest } from "../connectors/supabase-rest";
import type { Env } from "../env";
import { dispatchDossiers } from "./dossier-round";
import { tick, type TickSummary } from "./tick";

/** #333 O cron de 15 minutos: a captura, as publicações, a varredura do prazo, a rodada do Claude sem o auditor e o motor (tick; #311 sem o dossiê). Igual ao de api/wrangler.jsonc. */
export const CLAUDE_CRON = "*/15 * * * *";

/** #333 O cron do auditor: deslocado do de 15 minutos (minutos 7, 22, 37 e 52), para as duas invocações não coincidirem. Igual ao de api/wrangler.jsonc. */
export const AUDIT_CRON = "7-59/15 * * * *";

/**
 * #311 O cron do dossiê: deslocado dos outros dois (minutos 11, 26, 41 e 56), para as três invocações não coincidirem. Igual ao de api/wrangler.jsonc.
 * O plano gratuito permite 5 cron triggers por conta (docs da Cloudflare); este Worker usa 3. Outros Workers da conta não foram conferidos.
 */
export const DOSSIER_CRON = "11-59/15 * * * *";

/** #333 O que cada cron roda; os testes trocam por espiões. */
export interface Runners {
  readonly tick: (controller: Pick<ScheduledController, "cron">, env: Env) => Promise<TickSummary | null>;
  readonly audit: (controller: Pick<ScheduledController, "cron">, env: Env) => Promise<void>;
  readonly dossier: (controller: Pick<ScheduledController, "cron">, env: Env) => Promise<void>;
}

/** #333 AC-4 O cron que não é nenhum dos configurados não roda nada: uma linha, só com a expressão do cron, que não é segredo. */
export async function dispatchScheduled(
  controller: Pick<ScheduledController, "cron">,
  env: Env,
  runners: Runners = { tick, audit: auditTick, dossier: dossierTick },
): Promise<void> {
  if (controller.cron === CLAUDE_CRON) {
    await runners.tick(controller, env);
  } else if (controller.cron === AUDIT_CRON) {
    await runners.audit(controller, env);
  } else if (controller.cron === DOSSIER_CRON) {
    await runners.dossier(controller, env);
  } else {
    console.log(`cron: cron desconhecido (${controller.cron}); nada rodou`);
  }
}

/**
 * #333 AC-2 A invocação do auditor: só a rodada do Claude restrita ao auditor (runAuditRound), com o mesmo fail-closed: sem as
 * credenciais do Supabase, uma linha e volta; sem a do Claude, a própria rodada registra e volta.
 * Não grava automation_runs: a linha de rodada (#211) descreve a captura (notas vistas, propostas, publicações), que esta invocação
 * não faz, e gravá-la gastaria 1 subrequest e daria a ela uma linha de zeros; o auditor deixa o próprio rastro em claude_suggestions e nas auditorias.
 */
export async function auditTick(controller: Pick<ScheduledController, "cron">, env: Env): Promise<void> {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    console.log(`cron: execução agendada do auditor (${controller.cron}); sem credenciais do Supabase, auditoria pulada`);
    return;
  }
  await runAuditRound(new SupabaseRest({ url, secretKey }), env);
}

/**
 * #311 A invocação do dossiê: só a geração do dossiê das propostas que esperam uma pessoa (dispatchDossiers), com o mesmo fail-closed:
 * sem as credenciais do Supabase, uma linha e volta. Não grava automation_runs, como a do auditor: a linha de rodada (#211) descreve a captura.
 * O rastro desta invocação é dossier_requests (status, motivo) e claude_suggestions.
 */
export async function dossierTick(controller: Pick<ScheduledController, "cron">, env: Env): Promise<void> {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    console.log(`cron: execução agendada do dossiê (${controller.cron}); sem credenciais do Supabase, dossiê pulado`);
    return;
  }
  const rest = new SupabaseRest({ url, secretKey });
  await dispatchDossiers(env, rest, supabaseConnectors(rest).captureDeps);
}
