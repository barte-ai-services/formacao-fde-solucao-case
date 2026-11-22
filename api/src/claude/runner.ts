/**
 * O laço das tarefas do Claude (#66, #171): roda no Cron do Worker. Para cada tarefa registrada, lê o
 * que está pendente, pergunta ao Claude e grava a sugestão em claude_suggestions. A regra
 * determinística confirma depois e, sem sugestão, decide sozinha (fail-closed).
 */
import { ClaudeError, DEFAULT_MODEL, type Ask, type Converse } from './client.js';
import { isInteger, isString, isTimestamp, partitionRows, shaped, type Shape } from './guards.js';
import { SupabaseRestError } from '../connectors/supabase-rest.js';
import type { Db, Row } from './db.js';
import type { ClaudeTask, PendingRequest } from './task.js';

const TABLE = 'claude_suggestions';
/** #66 Teto de pedidos por tarefa a cada rodada; o resto fica para a próxima. */
export const MAX_PER_RUN = 50;
/** #66 Depois de 3 tentativas com erro, a chave não é mais tentada pelo laço. */
export const MAX_ATTEMPTS = 3;
/** #66 Espera entre tentativas com erro: 5 min * 2^tentativas desde updated_at. */
export const BACKOFF_BASE_MS = 5 * 60_000;
const MAX_ERROR = 200;

export type RunOptions = {
  readonly db: Db;
  readonly ask: Ask;
  /** #230 O laço de tool use, para a tarefa que oferece tools; sem ele, essa tarefa falha fechada. */
  readonly converse?: Converse;
  readonly tasks: readonly ClaudeTask<unknown, unknown>[];
  readonly log: (line: string) => void;
  readonly limit?: number;
  /** #66 Valores que nunca podem aparecer na mensagem de erro gravada. */
  readonly secrets?: readonly string[];
  /** #66 Relógio injetável, para a espera entre tentativas ser testável. */
  readonly now?: () => Date;
  /** #171 Prazo da rodada (epoch em milissegundos): passado o prazo, o laço para e o resto fica para a próxima. */
  readonly deadline?: number;
};

export type RunResult = { readonly failedTasks: string[] };

/** #66 O que o laço lê de cada linha de claude_suggestions. */
type StoredSuggestion = {
  readonly input_key: string;
  readonly status: string;
  readonly attempts: number;
  readonly updated_at: string;
};

const isStoredSuggestion = shaped<StoredSuggestion>({
  input_key: isString,
  status: isString,
  attempts: isInteger,
  updated_at: isTimestamp,
} satisfies Shape<StoredSuggestion>);

/**
 * #66 O que vai para a coluna error e para o log. Só os erros que o Worker mesmo escreve
 * (ClaudeError e SupabaseRestError) levam a mensagem, truncada e sem segredo; qualquer outro, como os
 * do SDK e do processo do Claude Code, leva só o nome da classe, porque o texto deles não é nosso.
 */
export function storedError(error: unknown, secrets: readonly string[] = []): string {
  const name = error instanceof Error && /^\w{1,64}$/.test(error.name) ? error.name : 'Error';
  if (!(error instanceof ClaudeError || error instanceof SupabaseRestError)) return `${name}: erro inesperado`;
  // #171 Do Supabase fica só a operação, a tabela e o status: o detalhe pode trazer o corpo da resposta.
  let message = error instanceof SupabaseRestError ? `${error.operation} em ${error.table} falhou (HTTP ${error.status})` : error.message;
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redigido]');
  return `${name}: ${message.slice(0, MAX_ERROR)}`;
}

type Existing = { readonly byKey: Map<string, StoredSuggestion>; readonly dropped: number };

async function existingSuggestions(db: Db, task: string): Promise<Existing> {
  const rows = await db.select(TABLE, {
    select: 'input_key,status,attempts,updated_at',
    filters: { task: `eq.${task}` },
    order: 'input_key.asc',
  });
  const { valid, dropped } = partitionRows(rows, isStoredSuggestion);
  return { byKey: new Map(valid.map((row) => [row.input_key, row])), dropped };
}

export function inBackoff(row: { readonly attempts: number; readonly updated_at: string }, now: Date): boolean {
  return now.getTime() < Date.parse(row.updated_at) + BACKOFF_BASE_MS * 2 ** row.attempts;
}

/** #311 O estado de uma chave já gravada, lido por keyStates. */
export type KeyState = 'ok' | 'exhausted' | 'skip' | 'retry';

/**
 * #38 O estado de cada chave já gravada: `ok` para as prontas (#311, para fechar o pedido pendente delas), `exhausted` para a que errou MAX_ATTEMPTS vezes
 * (#311, nunca mais entra no lote), `skip` para as ainda na espera (a mesma regra de planQueue), `retry` para a que errou e já pode ser tentada. Serve à tarefa cujo pending() é caro.
 */
export async function keyStates(db: Db, task: string, now: Date): Promise<Map<string, KeyState>> {
  const { byKey } = await existingSuggestions(db, task);
  const keys = new Map<string, KeyState>();
  for (const row of byKey.values()) {
    if (row.status === 'ok') keys.set(row.input_key, 'ok');
    else if (row.attempts >= MAX_ATTEMPTS) keys.set(row.input_key, 'exhausted');
    else keys.set(row.input_key, inBackoff(row, now) ? 'skip' : 'retry');
  }
  return keys;
}

type Plan = { readonly queue: PendingRequest<unknown>[]; readonly waiting: number };

/**
 * #66 A fila da rodada: as chaves nunca tentadas primeiro, depois as que erraram. A chave em erro
 * com MAX_ATTEMPTS tentativas, ou ainda na espera, fica de fora. O teto vem depois dessa ordem.
 */
function planQueue(pending: readonly PendingRequest<unknown>[], existing: Existing, now: Date, limit: number): Plan {
  const fresh: PendingRequest<unknown>[] = [];
  const retries: PendingRequest<unknown>[] = [];
  let waiting = 0;
  for (const request of pending) {
    const row = existing.byKey.get(request.key);
    if (row === undefined) fresh.push(request);
    else if (row.status === 'ok') continue;
    else if (row.attempts >= MAX_ATTEMPTS || inBackoff(row, now)) waiting += 1;
    else retries.push(request);
  }
  return { queue: [...fresh, ...retries].slice(0, limit), waiting };
}

type Counts = { ok: number; failed: number; firstError: string | undefined };

async function runOne(
  task: ClaudeTask<unknown, unknown>,
  request: PendingRequest<unknown>,
  options: RunOptions,
  previous: StoredSuggestion | undefined,
  counts: Counts,
): Promise<boolean> {
  const attempts = previous?.attempts ?? 0;
  const clock = options.now ?? (() => new Date());
  const started = clock().getTime();
  let row: Row;
  try {
    const output = await task.run(request.input, options.ask, options.converse);
    row = { output, status: 'ok', error: null, attempts, ...task.rowFields?.({ latencyMs: clock().getTime() - started }) };
    counts.ok += 1;
  } catch (error) {
    const message = storedError(error, options.secrets);
    counts.failed += 1;
    counts.firstError ??= message;
    // #171 Limite de uso ou credencial recusada vale para a rodada toda: não gasta tentativa de nenhuma
    // chave nem grava linha de erro, e interrompe. A regra decide sozinha e a próxima rodada repete.
    if (error instanceof ClaudeError && error.isGlobal) return true;
    row = {
      output: null,
      status: 'error',
      error: message,
      attempts: attempts + 1,
      ...task.rowFields?.({ error, latencyMs: clock().getTime() - started }),
    };
  }
  const updatedAt = clock().toISOString();
  // #66 A linha nova entra com ignore-duplicates; a que estava em erro é refeita com merge-duplicates.
  await options.db.upsert(
    TABLE,
    [{ task: task.name, input_key: request.key, input: request.input, model: DEFAULT_MODEL, updated_at: updatedAt, ...row }],
    { onConflict: 'task,input_key', resolution: previous === undefined ? 'ignore' : 'merge' },
  );
  return false;
}

function summaryLine(
  name: string,
  pending: number,
  counts: Counts,
  extra: { waiting: number; dropped: number; stopped: boolean; outOfBudget: boolean },
): string {
  const parts = [`tarefa ${name}: ${pending} pendentes, ok ${counts.ok}, erro ${counts.failed}`];
  if (counts.firstError !== undefined) parts.push(`primeiro erro: ${counts.firstError}`);
  if (extra.stopped) parts.push('rodada interrompida: a regra decide sozinha');
  if (extra.outOfBudget) parts.push('orçamento da rodada esgotado: o resto fica para a próxima');
  if (extra.waiting > 0) parts.push(`em espera ${extra.waiting}`);
  if (extra.dropped > 0) parts.push(`linhas descartadas ${extra.dropped}`);
  return parts.join(', ');
}

type TaskOutcome = { readonly line: string; readonly failed: boolean; readonly stopped: boolean };

async function runTask(task: ClaudeTask<unknown, unknown>, options: RunOptions): Promise<TaskOutcome> {
  const existing = await existingSuggestions(options.db, task.name);
  const { requests, dropped } = await task.pending(options.db);
  const pending = requests.filter((request) => existing.byKey.get(request.key)?.status !== 'ok');
  const now = (options.now ?? (() => new Date()))();
  // #230 O teto da tarefa (`maxPerRun`) e o do #156/#36 (`limit`), quando houver, valem sobre o da rodada: vale o menor.
  const limit = Math.min(options.limit ?? MAX_PER_RUN, task.limit ?? Number.POSITIVE_INFINITY, task.maxPerRun ?? Number.POSITIVE_INFINITY);
  const plan = planQueue(pending, existing, now, limit);
  const counts: Counts = { ok: 0, failed: 0, firstError: undefined };
  let stopped = false;
  let outOfBudget = false;
  for (const request of plan.queue) {
    if (options.deadline !== undefined && (options.now ?? (() => new Date()))().getTime() >= options.deadline) {
      outOfBudget = true;
      break;
    }
    stopped = await runOne(task, request, options, existing.byKey.get(request.key), counts);
    if (stopped) break;
  }
  const extra = { waiting: plan.waiting, dropped: dropped + existing.dropped, stopped, outOfBudget };
  const line = summaryLine(task.name, pending.length, counts, extra);
  // #66 Todas as chamadas falharem é a tarefa falhar: fica contado e logado, com o token vencido ou sem cota.
  return { line, failed: counts.ok === 0 && counts.failed > 0, stopped };
}

/** #66 Roda as tarefas em sequência. A falha de uma tarefa inteira é registrada e não para as outras. */
export async function runTasks(options: RunOptions): Promise<RunResult> {
  const failedTasks: string[] = [];
  for (const task of options.tasks) {
    try {
      const outcome = await runTask(task, options);
      options.log(outcome.line);
      if (outcome.failed) failedTasks.push(task.name);
      // #171 Sem cota ou sem credencial, as outras tarefas só repetiriam a falha.
      if (outcome.stopped) break;
    } catch (error) {
      failedTasks.push(task.name);
      options.log(`tarefa ${task.name}: falhou (${storedError(error, options.secrets)})`);
    }
  }
  return { failedTasks };
}
