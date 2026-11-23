// #363 Forma do passo de rodada (a de automation/round-budget, #361); a parte 2 os pluga.
import type { RoundStep } from '../automation/round-budget.js';

/** #363 O passo da rodada é o `RoundStep` da #361 (o ponto de extensão real), não uma cópia: o plug é só acrescentar em `buildRoundSteps` e em `STEP_COSTS`. */
export type DemoRoundStep = RoundStep;

/** #363 Relógio injetado: o módulo nunca lê a hora sozinho. */
export type Clock = () => Date;

/** #363 Quantas rodadas inteiras passaram desde `since`, com `roundMs` por rodada (injetado: a demonstração roda a cada minuto, o ritmo normal a cada 15). */
export function roundsElapsed(now: Date, since: Date, roundMs: number): number {
  return Math.floor((now.getTime() - since.getTime()) / roundMs);
}
