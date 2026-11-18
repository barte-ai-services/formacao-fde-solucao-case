// #211 O estado da automação e a próxima rodada. O Cron roda a cada 15 minutos (wrangler.jsonc).
export const RUN_INTERVAL_MINUTES = 15;
const INTERVAL_MS = RUN_INTERVAL_MINUTES * 60_000;
/** #211 Mais de 2 rodadas sem rodar: a automação está parada. */
const STALLED_AFTER_MS = 3 * INTERVAL_MS;

export type AutomationState = 'ok' | 'failed' | 'stalled';

// #211 O próximo múltiplo de 15 minutos (UTC) depois de `now`: o que a agenda do Cron dispara.
export function nextRunAt(now: Date): Date {
  return new Date((Math.floor(now.getTime() / INTERVAL_MS) + 1) * INTERVAL_MS);
}

/** #211 Parada vale mais que falha: sem rodar há mais de 2 rodadas, a falha antiga não diz nada. */
export function automationState(
  last: { readonly startedAt: string; readonly status: 'ok' | 'failed' } | null,
  now: Date,
): AutomationState {
  if (!last) return 'stalled';
  if (now.getTime() - Date.parse(last.startedAt) > STALLED_AFTER_MS) return 'stalled';
  return last.status === 'ok' ? 'ok' : 'failed';
}
