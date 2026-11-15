/**
 * A rodada do Claude no Cron do Worker (#171). Falha fechada: sem credencial, com 429, com 401 ou com
 * qualquer erro, conta a falha, registra uma linha sem segredo e devolve. Nada aqui derruba o Cron: sem
 * sugestão gravada, a regra determinística decide sozinha (descriptionMatch e resolveProbableOrder).
 */
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { ClaudeClient, credentialsFromEnv, type ClaudeEnv, type FetchFn } from './client.js';
import { restDb } from './db.js';
import { runTasks, type RunResult } from './runner.js';
import { tasksFor } from './tasks/index.js';

/** #171 Pedidos por tarefa a cada rodada de 15 minutos; também cabe nos 50 subrequests do plano gratuito. O resto fica para a próxima. */
export const CRON_LIMIT = 10;

/** #171 Orçamento da rodada: o Claude é periférico e a captura é o caminho crítico, então a rodada para cedo. */
export const ROUND_BUDGET_MS = 2 * 60_000;

export type ClaudeRound = { readonly ran: boolean; readonly failedTasks: string[]; readonly failures: number };

export async function runClaudeRound(
  rest: SupabaseRest,
  env: ClaudeEnv,
  options: { readonly fetch?: FetchFn; readonly log?: (line: string) => void } = {},
): Promise<ClaudeRound> {
  const log = options.log ?? ((line: string) => console.log(line));
  const credentials = credentialsFromEnv(env);
  if (!credentials) {
    log('cron: sem credencial do Claude; tarefas do Claude puladas e a regra decide sozinha');
    return { ran: false, failedTasks: [], failures: 0 };
  }
  const client = new ClaudeClient({ credentials, fetch: options.fetch });
  const secrets = [credentials.kind === 'api-key' ? credentials.apiKey : credentials.token, env.BARTE_ACADEMY_SUPABASE_SECRET_KEY ?? ''];
  let result: RunResult = { failedTasks: [] };
  try {
    result = await runTasks({
      db: restDb(rest),
      ask: client.ask,
      tasks: tasksFor(rest),
      log: (line) => log(`cron: ${line}`),
      limit: CRON_LIMIT,
      deadline: Date.now() + ROUND_BUDGET_MS,
      secrets,
    });
  } catch {
    // #171 O erro pode vir do banco ou da rede; o texto não é nosso, fica só o fato.
    log('cron: tarefas do Claude falharam; a regra decide sozinha');
    return { ran: true, failedTasks: ['todas'], failures: client.failures };
  }
  log(`cron: Claude, chamadas ${client.calls}, falhas ${client.failures}, tarefas com falha [${result.failedTasks.join(', ')}]`);
  return { ran: true, failedTasks: result.failedTasks, failures: client.failures };
}
