/**
 * A rodada do Claude no Cron do Worker (#171). Falha fechada: sem credencial, com 429, com 401 ou com
 * qualquer erro, conta a falha, registra uma linha sem segredo e devolve. Nada aqui derruba o Cron: sem
 * sugestão gravada, a regra determinística decide sozinha (descriptionMatch e resolveProbableOrder).
 */
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { ClaudeClient, credentialsFromEnv, type ClaudeEnv, type FetchFn } from './client.js';
import { restDb } from './db.js';
import { runTasks, type RunResult } from './runner.js';
import type { ClaudeTask } from './task.js';
import { auditTasksFor, tasksFor } from './tasks/index.js';

/**
 * #171 Teto de pedidos por tarefa a cada rodada: vale o menor entre ele e o limite da própria tarefa (`limit`, #157/#12) e o seu
 * `maxPerRun` (#230) (runner.ts). Cada pedido custa 2 subrequests (a Messages API e o upsert).
 * #38 A conta honesta do tick (tick.ts), medida no kit com o FakePostgrest: a rodada quieta, sem nota nova, faz
 * umas 59 chamadas ao Supabase antes do Claude (a captura, as propostas, o E8, a doca, o app da loja e os títulos
 * duplicados; cada leitura de propostas do store custa 6) e 1 depois (automation_runs). Ou seja: no plano gratuito
 * (50 subrequests) o tick já passa do teto antes da rodada do Claude, e o que a rodada chama depois disso falha.
 * No plano pago o teto é 1000. A rodada do Claude vai por último para o que estourar não ser a captura.
 * Custo da rodada do Claude: 1 leitura de claude_suggestions por tarefa no laço, mais o pending() de cada uma.
 * O do dossiê: as propostas que esperam (6 leituras, 1 se não há nenhuma), 1 leitura das próprias chaves e, havendo
 * candidata, 1 dos pedidos da gaveta em andamento (#130); só
 * havendo chave nova ou pronta para nova tentativa vêm o contexto (7) e até 5 × 2. Sem nada novo: 7 a 8, sem chamar
 * o Claude. Com as tarefas do laço cheias, cada uma no limite dela (#157: 1 + 1 + 1 + 2 = 5 pedidos sem o auditor (#333), 5 × 2 = 10): as outras duas leem umas 7, o laço 3, o dossiê 7 + 7, e mais os 10 dos pedidos do laço.
 * #157 As tarefas do #157 trazem o limite delas (api/src/claude/tasks/index.ts e api/src/supplier/draft-task.ts) e o teto só protege uma tarefa nova sem limite.
 * #157 Conta de subrequests, com a fila cheia de cada tarefa e cada uma no limite dela (PostgREST + Messages API), medida por
 * #157 api/test/claude/budget.test.ts sobre tasksFor de verdade:
 * #157   casamento de descrição (limite 1): 5 + 1 = 6; ordem provável (limite 1): 11 + 1 = 12; rascunho do #156 (limite 2): 12 + 2 = 14;
 * #157   leitura da resposta (#157, limite 1): 11 + 1 = 12; a rodada: 44 (#157: a tarefa do rascunho da cobrança, 8 + 1 = 9, saiu do Cron: a varredura monta a cobrança pela regra).
 * #157   varredura do prazo (SUPPLIER_SWEEP_PER_ROUND = 1, api/src/cron/supplier-sweep.ts): 6.
 * #333 Duas invocações agendadas, cada uma com o próprio teto de 50 (api/src/cron/schedule.ts):
 * #333   a de 15 minutos (runClaudeRound, tasksFor, sem o auditor): varredura 6 + rodada do Claude 44 = 50 medidos, no teto (eram 58 com o auditor, que era o último e nunca rodava);
 * #333   a do auditor (runAuditRound, auditTasksFor, deslocada: 7-59/15): 1 nota por invocação (AUDIT_NOTES_PER_RUN), 2 chamadas à Messages API e 6 ao banco = 8 medidos com 2 voltas; no pior caso, as 16 voltas do teto próprio do auditor (AUDIT_MAX_TURNS) e as 8 leituras = 30 medidos e 32 pela conta, contra os 50 (tasks/invoice-audit.ts).
 * #157 Os 50 do plano gratuito contam só a rodada do Claude e a varredura, não a invocação inteira: a captura, proposeChecked, as
 * #157 publicações e as notas de devolução gastam subrequests antes (api/src/cron/tick.ts, runRound). O Worker é tratado como o plano
 * #157 gratuito (50 subrequests); a rodada de 15 minutos mede 50 e cabe (#333); a invocação inteira do Cron é do Spike #303.
 * #157 A rodada é de melhor esforço, pelo desenho fail-closed da #171: passado o limite do Worker, todo fetch seguinte lança: a chave em
 * #157 curso e as que vêm depois dela não gravam nada, as anteriores (de qualquer tarefa) já gravaram, e a regra decide sozinha o que ficou
 * #157 sem sugestão. A ordem de tasksFor decide qual tarefa passa fome primeiro: a leitura da #157 vem antes da ordem provável e do rascunho do #156.
 */
export const CRON_LIMIT = 2;

/** #171 Orçamento da rodada: o Claude é periférico e a captura é o caminho crítico, então a rodada para cedo. */
export const ROUND_BUDGET_MS = 2 * 60_000;

export type ClaudeRound = { readonly ran: boolean; readonly failedTasks: string[]; readonly failures: number };

/** #171 A rodada do Claude do Cron de 15 minutos: as tarefas de tasksFor, sem o auditor (#333). */
export function runClaudeRound(
  rest: SupabaseRest,
  env: ClaudeEnv,
  options: { readonly fetch?: FetchFn; readonly log?: (line: string) => void } = {},
): Promise<ClaudeRound> {
  return runRound(rest, env, tasksFor, options);
}

/** #333 A rodada do cron do auditor: o mesmo corpo e o mesmo fail-closed, só com as tarefas de auditTasksFor. */
export function runAuditRound(
  rest: SupabaseRest,
  env: ClaudeEnv,
  options: { readonly fetch?: FetchFn; readonly log?: (line: string) => void } = {},
): Promise<ClaudeRound> {
  return runRound(rest, env, auditTasksFor, options);
}

async function runRound(
  rest: SupabaseRest,
  env: ClaudeEnv,
  tasksOf: (rest: SupabaseRest) => readonly ClaudeTask<unknown, unknown>[],
  options: { readonly fetch?: FetchFn; readonly log?: (line: string) => void },
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
      tasks: tasksOf(rest),
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
