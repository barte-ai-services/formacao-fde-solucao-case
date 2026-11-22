/* #356 AC-1 O ritmo da rodada. O Cron da rodada dispara a cada minuto (wrangler.jsonc); com o modo
   demonstração desligado a rodada só roda no ritmo de sempre, a cada 15 minutos. */
export const DEFAULT_INTERVAL_MINUTES = 15;
export const DEMO_INTERVAL_MINUTES = 1;

export type RoundRhythm = {
  /** #356 AC-1 A rodada deste disparo roda? */
  readonly runs: boolean;
  /** #356 AC-1 O intervalo do modo, em minutos: o que a tela mostra e o que mede a próxima rodada. */
  readonly intervalMinutes: number;
};

/** #356 AC-1 O intervalo do modo: 1 minuto ligado, 15 desligado. */
export function modeIntervalMinutes(demoEnabled: boolean): number {
  return demoEnabled ? DEMO_INTERVAL_MINUTES : DEFAULT_INTERVAL_MINUTES;
}

/**
 * #356 AC-1 Decide se o disparo do Cron roda a rodada. Ligado, roda sempre. Desligado, só quando o
 * minuto UTC de `scheduledTime` (ms desde a época, o `controller.scheduledTime`) é múltiplo de 15;
 * os outros disparos saem sem gravar linha. Função pura: a leitura do modo é de quem chama.
 */
export function roundRhythm(demoEnabled: boolean, scheduledTime: number): RoundRhythm {
  const intervalMinutes = modeIntervalMinutes(demoEnabled);
  if (demoEnabled) return { runs: true, intervalMinutes };
  const minute = new Date(scheduledTime).getUTCMinutes();
  return { runs: minute % DEFAULT_INTERVAL_MINUTES === 0, intervalMinutes };
}
