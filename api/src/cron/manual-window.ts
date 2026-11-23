/*
 * #356 AC-2 A janela da rodada manual. `POST /api/admin/rodar-agora` responde 202 na hora e entrega a rodada ao `waitUntil`, que o
 * Worker mantém vivo só uns 30 s depois da resposta (a conta que a #130 fez em dossier/on-demand.ts). Passado esse prazo o Worker corta
 * o trabalho, o `finally` não roda, a linha de automation_runs não é gravada e a trava (LOCK_TTL_MS, 5 min) fica presa. Por isso a rodada
 * manual NÃO tem os limites do Cron (3 min e 45 s por pergunta): tem os daqui, e o que não coube fica adiado para a próxima rodada
 * (`deferredSteps`, o mesmo mecanismo do orçamento de subrequests). O Cron e a reconferência (`tickAfterLock`) não mudam.
 *
 * A CONTA, no pior caso (cada parcela é um teto, e a soma tem de ficar abaixo de WAIT_UNTIL_MS):
 *   1. MANUAL_LIMIT_MS = 9 s: o medidor (cron/round-meter.ts) recusa todo fetch novo depois disto e o executor (round-budget.ts) não
 *      começa passo novo (o passo fica adiado). A leitura do modo, a trava e a dos adiados contam: o relógio corre desde o medidor.
 *   2. O maior fetch em curso quando o limite chega: o do Claude, MANUAL_CLAUDE_TIMEOUT_MS = 6 s (era 45 s; o prazo da conversa
 *      inteira); o do banco, MANUAL_SUPABASE_TIMEOUT_MS = 4 s (era 10 s); o do Clef, no máximo CLEF_TIMEOUT_MS = 8 s (o menor entre o do banco, `clef_timeout_ms`, e este teto). Vale o maior: 8 s.
 *   3. A gravação (`record`: o insert e, antes da migração, o reenvio sem as colunas novas) e a soltura da trava passam pelo
 *      `reservedFetch`, sem corte de tempo mas com o timeout do banco: MANUAL_FINISH_TIMEOUT_MS = 3 s cada, 3 chamadas = 9 s.
 *   Total: 9 + 8 + 9 = 26 s < 30 s, com 4 s de folga para o que a conta não vê (a resposta de 202 e o agendamento do `waitUntil`).
 * O prazo das tarefas do Claude (MANUAL_CLAUDE_DEADLINE_MS = 7 s) é menor que o limite: nenhuma tarefa nova começa depois dele.
 * Quem mexer num destes números refaz a soma: test/cron/manual-window.test.ts a cobra.
 */

/** #356 AC-2 A vida do `waitUntil` depois da resposta. */
export const WAIT_UNTIL_MS = 30_000;
/** #356 AC-2 Depois disto nenhum fetch novo sai e nenhum passo novo começa; o que faltou fica adiado. */
export const MANUAL_LIMIT_MS = 9_000;
/** #356 AC-2 O prazo em que o Claude para de começar tarefa na rodada manual. */
export const MANUAL_CLAUDE_DEADLINE_MS = 7_000;
/** #356 AC-2 O timeout de uma pergunta ao Claude (a conversa toda) na rodada manual. */
export const MANUAL_CLAUDE_TIMEOUT_MS = 6_000;
/** #356 AC-2 O timeout de um fetch do banco nos passos da rodada manual. */
export const MANUAL_SUPABASE_TIMEOUT_MS = 4_000;
/** #356 AC-2 O timeout de cada fetch da gravação e da soltura da trava na rodada manual. */
export const MANUAL_FINISH_TIMEOUT_MS = 3_000;
/** #356 AC-2 O teto do prazo do Clef (Workers AI) na rodada manual: o menor entre ele e `engine_settings.clef_timeout_ms` (o padrão é 8 s) vale, então o banco não estoura a janela. */
export const CLEF_TIMEOUT_MS = 8_000;
/** #356 AC-2 As chamadas da gravação e da soltura: o insert, o reenvio sem as colunas novas (#311) e a soltura. */
export const FINISH_CALLS = 3;

/** #356 AC-2 O pior caso da rodada manual, a soma da conta acima. */
export const MANUAL_WORST_CASE_MS =
  MANUAL_LIMIT_MS +
  Math.max(MANUAL_CLAUDE_TIMEOUT_MS, MANUAL_SUPABASE_TIMEOUT_MS, CLEF_TIMEOUT_MS) +
  FINISH_CALLS * MANUAL_FINISH_TIMEOUT_MS;

/** #356 AC-2 Os limites da rodada manual que `executeRound` (tick.ts) liga; o Cron não passa nenhum. */
export type ManualWindow = {
  readonly limitMs: number;
  readonly claudeDeadlineMs: number;
  readonly claudeTimeoutMs: number;
  /** #356 AC-2 O teto do prazo do Clef: o menor entre ele e `engine_settings.clef_timeout_ms` vale, e a conta da janela não depende do banco. */
  readonly clefTimeoutMs: number;
  readonly supabaseTimeoutMs: number;
  readonly finishTimeoutMs: number;
};

export const MANUAL_WINDOW: ManualWindow = {
  limitMs: MANUAL_LIMIT_MS,
  claudeDeadlineMs: MANUAL_CLAUDE_DEADLINE_MS,
  claudeTimeoutMs: MANUAL_CLAUDE_TIMEOUT_MS,
  clefTimeoutMs: CLEF_TIMEOUT_MS,
  supabaseTimeoutMs: MANUAL_SUPABASE_TIMEOUT_MS,
  finishTimeoutMs: MANUAL_FINISH_TIMEOUT_MS,
};
