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

/**
 * #171 Pedidos por tarefa a cada rodada. Cada pedido custa 2 subrequests (a Messages API e o upsert).
 * #38 A conta honesta do tick (tick.ts), medida no kit com o FakePostgrest: a rodada quieta, sem nota nova, faz
 * umas 59 chamadas ao Supabase antes do Claude (a captura, as propostas, o E8, a doca, o app da loja e os títulos
 * duplicados; cada leitura de propostas do store custa 6) e 1 depois (automation_runs). Ou seja: no plano gratuito
 * (50 subrequests) o tick já passa do teto antes da rodada do Claude, e o que a rodada chama depois disso falha.
 * No plano pago o teto é 1000. A rodada do Claude vai por último para o que estourar não ser a captura.
 * Custo da rodada do Claude: 1 leitura de claude_suggestions por tarefa no laço, mais o pending() de cada uma.
 * O do dossiê: as propostas que esperam (6 leituras, 1 se não há nenhuma), 1 leitura das próprias chaves e, havendo
 * candidata, 1 dos pedidos da gaveta em andamento (#130); só
 * havendo chave nova ou pronta para nova tentativa vêm o contexto (7) e até 5 × 2. Sem nada novo: 7 a 8, sem chamar
 * o Claude. Com as três tarefas cheias: as outras duas leem umas 7, o laço 3, o dossiê 7 + 7, e 3 × 5 × 2 = 54.
 * #230 O auditor (invoice-audit, `maxPerRun` 1) soma 22 no pior caso; a conta está em tasks/invoice-audit.ts.
 */
export const CRON_LIMIT = 5;

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
      converse: (options) => client.converse(options),
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
