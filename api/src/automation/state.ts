// #211 O estado da automação e a próxima rodada. #356 O ritmo depende do modo demonstração (1 ou 15 min).
import { DEFAULT_INTERVAL_MINUTES } from './rhythm.js';

export const RUN_INTERVAL_MINUTES = DEFAULT_INTERVAL_MINUTES;
/** #356 AC-5 Parada se mede sempre em intervalos de 15 minutos, em qualquer modo: com o ritmo de 1
 *  minuto não há falso alarme, e a troca de modo não muda a régua. */
const STALLED_AFTER_MS = 3 * RUN_INTERVAL_MINUTES * 60_000;

export type AutomationState = 'ok' | 'failed' | 'stalled';

// #211 O próximo múltiplo do intervalo (UTC) depois de `now`: o que a agenda do Cron dispara.
// #356 AC-5 `intervalMinutes` é o do modo (1 ligado, 15 desligado); sem ele, 15 como sempre.
export function nextRunAt(now: Date, intervalMinutes: number = RUN_INTERVAL_MINUTES): Date {
  const intervalMs = intervalMinutes * 60_000;
  return new Date((Math.floor(now.getTime() / intervalMs) + 1) * intervalMs);
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
