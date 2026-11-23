// #363 Forma do passo de rodada, estruturalmente igual à de automation/round-budget (PR #361); a parte 2 os pluga.

export type DemoRoundStep = {
  readonly name: string;
  readonly maxSubrequests: number;
  readonly critical?: boolean;
  readonly run: () => Promise<void>;
};

/** #363 Relógio injetado: o módulo nunca lê a hora sozinho. */
export type Clock = () => Date;

/** #363 Quantas rodadas inteiras passaram desde `since`, com `roundMs` por rodada (o cron roda a cada 15 min). */
export function roundsElapsed(now: Date, since: Date, roundMs: number): number {
  return Math.floor((now.getTime() - since.getTime()) / roundMs);
}
