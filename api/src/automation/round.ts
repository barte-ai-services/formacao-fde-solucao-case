/*
 * #356 A rodada orquestrada (caso de uso): o disparo, o ritmo do modo, a trava, os passos contra o orçamento e a
 * gravação da rodada. Só fala com as portas abaixo, cada chamada a uma porta é UMA requisição (é isso que o
 * ROUND_RESERVE de round-budget.ts conta: modo, trava, adiados, gravação e soltura = 5 de 7). O adaptador real
 * das portas é da camada OLTP (sobre o SupabaseRest); o despacho do Cron é da camada API.
 */
import { executeRound, type RoundOutcome, type RoundStep } from './round-budget.js';
import { modeIntervalMinutes, roundRhythm } from './rhythm.js';
import { NO_FIGURES, type RunFigures } from './runs.js';

/**
 * #356 AC-3 A validade da trava: 5 minutos. A conta: o medidor da rodada (cron/round-meter.ts) recusa todo fetch novo
 * depois de ROUND_LIMIT_MS = 3 min do começo, e o fetch em curso nesse instante leva no máximo ASK_TIMEOUT_MS = 45 s
 * (o maior prazo de um fetch: Messages API do Cron; o Supabase leva 10 s, o Clef 8 s), então a rodada
 * acaba em no máximo 3 min + 45 s = 225 s, e 300 s > 225 s: uma rodada viva nunca perde a trava. Os passos do Claude
 * dividem UM prazo de ROUND_BUDGET_MS = 2 min por rodada (não um por passo), fixado ao montar a rodada. E é curta o bastante
 * para que, se o Worker morrer com a trava tomada, o modo de 1 minuto perca no máximo 5 rodadas (puladas, e gravadas como
 * skipped) até a trava vencer sozinha.
 */
export const LOCK_TTL_MS = 5 * 60_000;

export type RoundOrigin = 'cron' | 'manual';
/** #356 AC-1 O disparo: o Cron traz o `controller.scheduledTime`; a rodada manual não tem ritmo a respeitar. */
export type RoundTrigger = { readonly origin: 'cron'; readonly scheduledTime: number } | { readonly origin: 'manual' };
export type RoundRunStatus = 'ok' | 'failed' | 'skipped';

/** #356 AC-1 AC-3 AC-4 O que fica gravado em automation_runs: a origem, o modo, os passos adiados e a classe do erro. */
export type RoundRecord = {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly status: RoundRunStatus;
  readonly origin: RoundOrigin;
  readonly demoEnabled: boolean;
  readonly figures: RunFigures;
  /** #356 AC-4 A classe do erro, nunca a mensagem. */
  readonly error: string | null;
  /** #356 AC-4 Os passos que não couberam, na ordem de espera: a rodada seguinte os lê (`lastDeferred`). */
  readonly deferredSteps: readonly string[];
  /**
   * #311 Os passos periféricos que falharam sozinhos (nomes fixos): a rodada com passo falho segue `ok` e `failed_steps`
   * (migração 20261122130000) diz quais. Vazio na rodada pulada.
   */
  readonly failedSteps: readonly string[];
  /** #311 Os subrequests que a invocação gastou até a gravação, a própria incluída, contra os 50; nulo sem medidor. */
  readonly subrequests: number | null;
};

/**
 * #356 AC-4 O que a rodada executa: a lista ordenada de passos (o ponto de extensão de round-budget.ts), os números
 * da rodada ao final e quais passos, se falharem, fazem a rodada ser gravada como `failed` (os que antes
 * derrubavam o Cron por não serem isolados). Montada só depois da trava tomada.
 */
export type RoundBuild = {
  readonly steps: RoundStep[];
  readonly figures: () => RunFigures;
  readonly failsRound: ReadonlySet<string>;
  /** #311 Os passos periféricos que engoliram a própria falha (e a registraram) durante a rodada; os que lançaram vêm do executor. */
  readonly failedSteps: () => readonly string[];
};

export type DemoModeState = { readonly enabled: boolean; readonly changedAt: string | null };

export interface RoundPorts {
  readonly mode: {
    /** #356 AC-1 O modo (a linha única de demo_settings). */
    read(): Promise<DemoModeState>;
    /** #356 AC-2 Grava o modo, quem mudou (o e-mail do Access, nulo no service token) e quando. */
    write(change: { enabled: boolean; changedBy: string | null; changedAt: Date }): Promise<void>;
  };
  readonly lock: {
    /** #356 AC-3 Toma a trava para `owner` por `validForMs`; falso se outra, ainda válida, a tem. Vencida, é tomada. */
    take(owner: string, validForMs: number): Promise<boolean>;
    /** #356 AC-3 Solta só a trava do `owner`; a de outro dono fica como está. */
    release(owner: string): Promise<void>;
  };
  readonly history: {
    /** #356 AC-4 Os adiados da última rodada que rodou de fato (ok ou failed); a pulada não conta. */
    lastDeferred(): Promise<readonly string[]>;
    record(record: RoundRecord): Promise<void>;
  };
  buildRound(): RoundBuild;
  /**
   * #356 AC-4 O gasto medido da invocação, em subrequests, fetch a fetch (cron/round-meter.ts). Sem ele, só o conjunto
   * garantido pelos custos declarados roda; com ele, o passo fora do garantido roda quando o gasto real deixa lugar.
   */
  spent?(): number;
  /** #311 Quantas chamadas, ou passos inteiros, o medidor recusou: o passo que engole a recusa também falhou. */
  refused?(): number;
  newOwner(): string;
  now(): Date;
  /** #356 Uma linha de log sem dado sensível: nomes de passo e classes de erro. */
  log(line: string): void;
}

export type RoundResult =
  | { readonly kind: 'off-rhythm' }
  | { readonly kind: 'locked' }
  | {
      readonly kind: 'done';
      readonly status: 'ok' | 'failed';
      readonly error: string | null;
      readonly deferred: readonly string[];
      readonly figures: RunFigures;
    };

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/**
 * #356 AC-1 AC-3 AC-4 Uma rodada: ritmo, trava, passos, gravação e soltura. #356 AC-3 Com `held`, quem chama já tomou a trava para
 * esse dono (a reconferência, que apaga o domínio antes): a rodada não toma de novo e a solta no fim, a mesma posse.
 */
export async function runRound(ports: RoundPorts, trigger: RoundTrigger, held?: string): Promise<RoundResult> {
  const startedAt = ports.now();
  if (held !== undefined) return runHeld(ports, trigger, held, startedAt);
  const demo = await ports.mode.read();
  if (trigger.origin === 'cron' && !roundRhythm(modeIntervalMinutes(demo.enabled), trigger.scheduledTime).runs) {
    return { kind: 'off-rhythm' };
  }
  const owner = ports.newOwner();
  if (!(await ports.lock.take(owner, LOCK_TTL_MS))) {
    await recordSafely(ports, {
      startedAt, finishedAt: ports.now(), status: 'skipped', origin: trigger.origin, demoEnabled: demo.enabled,
      figures: NO_FIGURES, error: null, deferredSteps: [], failedSteps: [], subrequests: recordedSubrequests(ports),
    });
    return { kind: 'locked' };
  }
  try {
    return await runLocked(ports, trigger.origin, demo.enabled, startedAt);
  } finally {
    await releaseSafely(ports, owner);
  }
}

/**
 * #356 AC-3 A rodada de quem já tem a trava: a posse é dele desde antes da primeira leitura, então TUDO daqui, a leitura do modo inclusive,
 * fica dentro do try/finally que a solta. É o único lugar que solta a trava de uma rodada com `held`; sem ritmo a respeitar (a reconferência é manual).
 */
async function runHeld(ports: RoundPorts, trigger: RoundTrigger, held: string, startedAt: Date): Promise<RoundResult> {
  try {
    const demo = await ports.mode.read();
    return await runLocked(ports, trigger.origin, demo.enabled, startedAt);
  } finally {
    await releaseSafely(ports, held);
  }
}

/** #356 AC-2 A rodada manual ("rodar agora"): sem ritmo, mas com a trava. */
export function runNow(ports: RoundPorts): Promise<RoundResult> {
  return runRound(ports, { origin: 'manual' });
}

/** #356 AC-2 Liga ou desliga o modo demonstração e devolve o estado gravado. */
export async function setDemoMode(
  ports: Pick<RoundPorts, 'mode' | 'now'>,
  change: { readonly enabled: boolean; readonly changedBy: string | null },
): Promise<{ readonly enabled: boolean; readonly changedAt: string }> {
  const changedAt = ports.now();
  await ports.mode.write({ enabled: change.enabled, changedBy: change.changedBy, changedAt });
  return { enabled: change.enabled, changedAt: changedAt.toISOString() };
}

async function runLocked(
  ports: RoundPorts,
  origin: RoundOrigin,
  demoEnabled: boolean,
  startedAt: Date,
): Promise<RoundResult> {
  const before = await deferredBefore(ports);
  let build: RoundBuild | null = null;
  let outcome: RoundOutcome;
  let error: string | null = null;
  try {
    // #356 AC-4 A montagem também lança (custo de tarefa do Claude sem medida): a trava já está tomada, então a rodada grava failed e a solta.
    build = ports.buildRound();
    outcome = await executeRound(build.steps, before, ports.spent?.bind(ports), ports.refused?.bind(ports));
  } catch (e) {
    // #356 AC-4 Custo mal declarado (planRound) ou rodada que não montou: a rodada não roda, fica gravada como failed, e os adiados ficam como estavam.
    outcome = { ran: [], failed: [], deferred: [...before], overspent: [] };
    error = errorClass(e);
  }
  for (const f of outcome.failed) ports.log(`cron: passo ${f.name} falhou (${f.error}); a próxima rodada repete`);
  if (outcome.deferred.length > 0) ports.log(`cron: passos adiados para a próxima rodada [${outcome.deferred.join(', ')}]`);
  for (const o of outcome.overspent) ports.log(`cron: passo ${o.name} gastou ${o.measured} subrequests, declarou ${o.declared}; corrija o custo declarado`);
  const fatal = build ? outcome.failed.find((f) => build.failsRound.has(f.name)) : undefined;
  error ??= fatal?.error ?? null;
  const status = error === null ? 'ok' : 'failed';
  const figures = build ? build.figures() : NO_FIGURES;
  // #311 Cada passo falha sozinho: o que lançou e o que engoliu a própria falha entram em failed_steps; a captura (o caminho crítico) é o status `failed`.
  const failedSteps = [...new Set([...(build?.failedSteps() ?? []), ...outcome.failed.map((f) => f.name).filter((n) => !build?.failsRound.has(n))])];
  await recordSafely(ports, {
    startedAt, finishedAt: ports.now(), status, origin, demoEnabled, figures, error, deferredSteps: outcome.deferred,
    failedSteps, subrequests: recordedSubrequests(ports),
  });
  return { kind: 'done', status, error, deferred: outcome.deferred, figures };
}

/** #311 O gasto da invocação até a gravação: o medido mais a própria gravação, como a #311 conta. */
function recordedSubrequests(ports: RoundPorts): number | null {
  return ports.spent ? ports.spent() + 1 : null;
}

/** #356 AC-4 A leitura dos adiados é só histórico: se falha, a rodada roda na ordem de hoje e a falha fica no log. */
async function deferredBefore(ports: RoundPorts): Promise<readonly string[]> {
  try {
    return await ports.history.lastDeferred();
  } catch (e) {
    ports.log(`cron: adiados da rodada anterior não lidos (${errorClass(e)}); segue na ordem de hoje`);
    return [];
  }
}

/** #211 A gravação da rodada é observação: se falha, uma linha com a classe do erro e o Cron segue. */
async function recordSafely(ports: RoundPorts, record: RoundRecord): Promise<void> {
  try {
    await ports.history.record(record);
  } catch (e) {
    ports.log(`cron: rodada não registrada (${errorClass(e)})`);
  }
}

/** #356 AC-3 Soltar a trava é o último passo; se falha, a validade a vence sozinha. */
async function releaseSafely(ports: RoundPorts, owner: string): Promise<void> {
  try {
    await ports.lock.release(owner);
  } catch (e) {
    ports.log(`cron: trava não solta (${errorClass(e)}); vence sozinha em ${LOCK_TTL_MS / 60_000} minutos`);
  }
}
