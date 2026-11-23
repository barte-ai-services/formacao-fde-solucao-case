// #333 O despacho do `scheduled` pelo `controller.cron`: o Worker tem três cron triggers (api/wrangler.jsonc), cada um com o próprio teto de 50 subrequests (#311 o terceiro é o do dossiê).
// #356 O primeiro é o de minuto: a rodada decide pelo modo demonstração se roda naquele minuto (cron/tick.ts, automation/rhythm.ts).
import { runAuditRound } from "../claude/cron";
import { supabaseConnectors } from "../connectors/supabase-connectors";
import { SupabaseRest } from "../connectors/supabase-rest";
import type { Env } from "../env";
import { dispatchDossiers } from "./dossier-round";
import { countSubrequests, subrequestsLine } from "./subrequests";
import { tick, type TickController, type TickSummary } from "./tick";

/**
 * #356 O cron do tick: dispara TODO minuto; quem decide se a rodada roda é o modo demonstração (ligado, todo minuto; desligado, só nos
 * minutos múltiplos de 15 de `scheduledTime`, UTC). A rodada é a captura, as publicações, a varredura do prazo, a rodada do Claude sem o
 * auditor e o motor, em passos orçados (tick; #311 sem o dossiê). Igual ao de api/wrangler.jsonc.
 */
export const TICK_CRON = "* * * * *";

/** #333 O cron do auditor: deslocado dos minutos cheios da rodada de 15 em 15 (minutos 7, 22, 37 e 52). #356 Com o tick de minuto os três coincidem nesses minutos, em invocações separadas, cada uma com o próprio teto de 50 e despachada só ao seu handler. Igual ao de api/wrangler.jsonc. */
export const AUDIT_CRON = "7-59/15 * * * *";

/**
 * #311 O cron do dossiê: deslocado dos outros dois (minutos 11, 26, 41 e 56); o tick de minuto (#356) coincide com ele, em invocações separadas. Igual ao de api/wrangler.jsonc.
 * O plano gratuito permite 5 cron triggers por conta (docs da Cloudflare); este Worker usa 3. Outros Workers da conta não foram conferidos.
 */
export const DOSSIER_CRON = "11-59/15 * * * *";

/** #333 O que cada cron roda; os testes trocam por espiões. */
export interface Runners {
  readonly tick: (controller: TickController, env: Env) => Promise<TickSummary | null>;
  readonly audit: (controller: Pick<ScheduledController, "cron">, env: Env) => Promise<void>;
  readonly dossier: (controller: Pick<ScheduledController, "cron">, env: Env) => Promise<void>;
}

/** #333 AC-4 O cron que não é nenhum dos configurados não roda nada: uma linha, só com a expressão do cron, que não é segredo. */
export async function dispatchScheduled(
  controller: TickController,
  env: Env,
  runners: Runners = { tick, audit: auditTick, dossier: dossierTick },
): Promise<void> {
  if (controller.cron === TICK_CRON) {
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
 * #311 Termina sempre com a linha `cron: subrequests n/50 (dossiê <cron>)`, o n contado pelo fetch da invocação (PostgREST e Messages API).
 */
export async function dossierTick(controller: Pick<ScheduledController, "cron">, env: Env): Promise<void> {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    console.log(`cron: execução agendada do dossiê (${controller.cron}); sem credenciais do Supabase, dossiê pulado`);
    return;
  }
  // #311 O fetch por invocação conta o PostgREST e a Messages API; a linha final diz quantos subrequests foram contra os 50.
  const counter = countSubrequests();
  const rest = new SupabaseRest({ url, secretKey, fetch: counter.fetch });
  try {
    await dispatchDossiers(env, rest, supabaseConnectors(rest).captureDeps, counter.fetch);
  } finally {
    console.log(subrequestsLine(counter.count(), `dossiê ${controller.cron}`));
  }
}
