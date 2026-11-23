/*
 * #356 O tick: a invocação do Cron de minuto (api/wrangler.jsonc, src/cron/schedule.ts) e a rodada manual ("rodar agora") sobre a
 * rodada orquestrada (automation/round.ts): o ritmo do modo, a trava, os passos contra o orçamento de 50 subrequests e a gravação.
 *
 * UM medidor por invocação (cron/round-meter.ts, o contador da #311): `rest` e o Claude usam o `meter.fetch`, o `ai.run` entra pelo
 * `meter.env`, e a gravação da rodada e a soltura da trava usam o `meter.reservedFetch`, o único que gasta a reserva. Tudo o que sai
 * do Worker na rodada, as portas do modo e da trava inclusive, passa por ele; a linha final diz o gasto contra os 50.
 *
 * Os passos, na ordem, e os custos declarados estão em round-steps.ts (o ponto de extensão da #349 e da #351); o trabalho de cada
 * passo, em round-work.ts. O dossiê não é daqui: tem o cron próprio (#311, cron/dossier-round.ts).
 */
import { LOCK_TTL_MS, runRound, type RoundPorts, type RoundResult, type RoundTrigger } from "../automation/round.js";
import { supabaseRoundStore } from "../automation/round-store.js";
import { SupabaseRest } from "../connectors/supabase-rest";
import type { Env } from "../env";
import { startRoundMeter } from "./round-meter";
import { buildRoundSteps } from "./round-steps";
import { supabaseRoundWork } from "./round-work";
import { subrequestsLine } from "./subrequests";

/** #174 O que uma rodada fez, para a reconferência devolver. Nulo quando a rodada foi pulada. */
export interface TickSummary {
  seen: number;
  inserted: number;
  checked: number;
  failed: number;
  proposed: number;
}

/** #356 AC-1 O que o `scheduled` entrega: a expressão e o instante agendado (o `scheduledTime` decide o ritmo). Sem ele, a rodada é manual. */
export type TickController = Pick<ScheduledController, "cron"> & { readonly scheduledTime?: number };

/** #211 A rodada falhou na captura, o caminho crítico: o Cron registra a invocação como falha, só com a classe do erro. */
export class RoundFailedError extends Error {
  constructor(readonly errorClass: string) {
    super(`a rodada falhou (${errorClass})`);
    this.name = "RoundFailedError";
  }
}

/**
 * #356 AC-1 Execução agendada. Com o `scheduledTime` é uma rodada do Cron (o ritmo do modo vale); sem ele, como na reconferência (#56), é
 * manual e roda. Devolve o resumo da rodada, ou nulo se ela não rodou (fora do ritmo, trava tomada ou sem credenciais do Supabase).
 * #211 AC-1 Se a captura falha, a rodada fica gravada como `failed` e o erro sobe.
 */
export async function tick(controller: TickController, env: Env): Promise<TickSummary | null> {
  const trigger: RoundTrigger =
    controller.scheduledTime === undefined ? { origin: "manual" } : { origin: "cron", scheduledTime: controller.scheduledTime };
  return summarize(await executeRound(env, trigger, `tick ${controller.cron}`));
}

/** #356 AC-3 A reconferência pediu a trava e outra rodada, ainda válida, a tem: nada foi apagado nem gravado. */
export class RoundInProgressError extends Error {
  constructor() {
    super("já há uma rodada em andamento");
    this.name = "RoundInProgressError";
  }
}

/**
 * #356 AC-3 A rodada da reconferência: toma a trava ANTES de `before` (o apagamento do domínio) e a rodada corre com essa mesma posse,
 * solta no fim. Trava tomada e válida: lança `RoundInProgressError` sem chamar `before`. Se `before` falha, a trava é solta e o erro sobe.
 */
export async function tickAfterLock(controller: TickController, env: Env, before: () => Promise<void>): Promise<TickSummary | null> {
  const result = await executeRound(env, { origin: "manual" }, `tick ${controller.cron}`, before);
  if (result?.kind === "locked") throw new RoundInProgressError();
  return summarize(result);
}

function summarize(result: RoundResult | null): TickSummary | null {
  if (result?.kind !== "done") return null;
  if (result.status === "failed") throw new RoundFailedError(result.error ?? "Error");
  const { seen, inserted, checked, failed, proposed } = result.figures;
  return { seen, inserted, checked, failed, proposed };
}

/**
 * #356 AC-2 A rodada manual (`POST /api/admin/rodar-agora`): sem ritmo, mas com a trava. Nunca lança por falha da rodada: ela fica
 * gravada como `failed`, e quem chama (o waitUntil) só precisa esperar. Nulo sem as credenciais do Supabase.
 */
export function runManualRound(env: Env): Promise<RoundResult | null> {
  return executeRound(env, { origin: "manual" }, "rodar agora");
}

/** #356 Monta o medidor, as portas e a rodada da invocação; a linha de subrequests sai sempre, inclusive quando a rodada não roda. */
async function executeRound(env: Env, trigger: RoundTrigger, label: string, before?: () => Promise<void>): Promise<RoundResult | null> {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    console.log(`cron: execução agendada (${label}); sem credenciais do Supabase, rodada pulada`);
    return null;
  }
  const meter = startRoundMeter(env);
  const rest = new SupabaseRest({ url, secretKey, fetch: meter.fetch });
  const finish = new SupabaseRest({ url, secretKey, fetch: meter.reservedFetch });
  const log = (line: string): void => console.log(line);
  const work = supabaseRoundWork(rest, meter.env, meter.fetch);
  const ports: RoundPorts = {
    ...supabaseRoundStore({ rest, finish, log }),
    buildRound: () => buildRoundSteps(work),
    spent: meter.spent,
    refused: meter.refused,
    newOwner: () => crypto.randomUUID(),
    now: () => new Date(),
    log,
  };
  let result: RoundResult | null = null;
  try {
    result = before ? await runAfterLock(ports, trigger, before) : await runRound(ports, trigger);
    return result;
  } finally {
    // #356 AC-1 Fora do ritmo a invocação só leu o modo: uma linha por minuto no log não diz nada, e a leitura não é uma rodada.
    if (result?.kind !== "off-rhythm") console.log(subrequestsLine(meter.spent(), label));
  }
}

/** #356 AC-3 Toma a trava, roda `before` e entrega a rodada à mesma posse; `before` que falha solta a trava (a validade cobre se a soltura também falhar). */
async function runAfterLock(ports: RoundPorts, trigger: RoundTrigger, before: () => Promise<void>): Promise<RoundResult> {
  const owner = ports.newOwner();
  if (!(await ports.lock.take(owner, LOCK_TTL_MS))) return { kind: "locked" };
  try {
    await before();
  } catch (error) {
    await ports.lock.release(owner).catch(() => ports.log("cron: trava não solta; vence sozinha"));
    throw error;
  }
  return runRound(ports, trigger, owner);
}
