// #38 O dossiê disparado pelo evento: a proposta que espera uma pessoa e ainda não tem dossiê pronto, seja nova, seja
// das que ficaram de fora por causa do teto ou de uma falha anterior. #311 Quem chama é o cron próprio do dossiê
// (cron/dossier-round.ts), que espera cada disparo para parar o lote no primeiro erro global. Não há rodada agendada do laço de tarefas (#66/#171).
import { inBackoff } from '../claude/runner.js';
import { ClaudeError, DEFAULT_MODEL, spentUsage, type AskWithUsage, type Usage } from '../claude/client.js';
import type { Db } from '../claude/db.js';
import { MAX_ATTEMPTS, storedError } from '../claude/runner.js';
import { dossierRequest, failureReason, parseDossierOutput, type DossierInput } from '../claude/tasks/dossier.js';
import type { CheckContext, InvoiceView } from '../domain/index.js';
import {
  inFlight,
  isGlobalReason,
  IN_FLIGHT_MS,
  NoCredentialsError,
  requestReasonOf,
  type Closing,
  type DossierRequest,
  type DossierRequests,
  type GlobalReason,
} from './requests.js';
import { DOSSIER_TASK } from './source.js';

const TABLE = 'claude_suggestions';

/** #38 O que o disparo do evento precisa; tudo injetável nos testes. */
export type EventDossierDeps = {
  /** #38 O banco das sugestões, o mesmo Db do laço (#66) e do pedido sob demanda (#130). */
  readonly db: Db;
  /** #38 O contexto da nota, como a gaveta e o pedido sob demanda montam (#68). */
  readonly context: (invoiceAccessKey: string) => Promise<CheckContext>;
  /**
   * #38 O Claude com o uso de tokens, para a coluna `usage`. Obrigatório no tipo (sem credencial, undefined
   * explícito): quem monta as dependências não esquece a ligação sem quebrar o tsc.
   */
  readonly askWithUsage: AskWithUsage | undefined;
  /** #38 Valores que nunca podem aparecer na coluna error nem no log (o token, a chave do Supabase). */
  readonly secrets?: readonly string[];
  /** #130 As chaves com pedido da gaveta ainda em andamento: o evento não chama o Claude para elas. */
  readonly busy?: ReadonlySet<string>;
  /**
   * #130 #38 AC-1 Os pedidos do dossiê: o evento abre o seu (trigger `event`, requested_by `claude`) antes de chamar o
   * Claude e o fecha no fim, para a gaveta mostrar "Gerando" e o pedido da gaveta receber 409 enquanto isso.
   * Obrigatório: sem ele o evento chamaria o Claude sem a linha que a gaveta e o 409 leem.
   */
  readonly requests: DossierRequests;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
};

type Previous = { readonly status: string; readonly attempts: number; readonly updated_at: string };

async function previousRow(db: Db, invoiceAccessKey: string): Promise<Previous | undefined> {
  const rows = (await db.select(TABLE, {
    select: 'status,attempts,updated_at',
    order: 'input_key.asc',
    filters: { task: `eq.${DOSSIER_TASK}`, input_key: `eq.${invoiceAccessKey}` },
  })) as Partial<Record<keyof Previous, unknown>>[];
  const [first] = rows;
  if (!first || typeof first.status !== 'string') return undefined;
  return {
    status: first.status,
    attempts: typeof first.attempts === 'number' ? first.attempts : 0,
    updated_at: typeof first.updated_at === 'string' ? first.updated_at : new Date(0).toISOString(),
  };
}

/**
 * #130 As chaves com pedido em andamento (`running`, aberto há menos de IN_FLIGHT_MS): o disparo do evento e a rede de
 * segurança não chamam o Claude para elas. #311 O `pending` não conta: espera a vez e não trava a geração.
 */
export function busyKeysOf(requests: readonly DossierRequest[], now: Date): Set<string> {
  const keys = new Set<string>();
  for (const r of requests) if (inFlight([r], now)) keys.add(r.input_key);
  return keys;
}

/** #130 Uma leitura só, para o tick inteiro. */
export async function busyKeys(requests: DossierRequests, now: Date): Promise<Set<string>> {
  return busyKeysOf(await requests.window(new Date(now.getTime() - IN_FLIGHT_MS)), now);
}

/**
 * #38 Gera e grava o dossiê de uma proposta que espera uma pessoa. Elegível quando não há linha, ou quando a linha
 * de erro já pode ser refeita (menos de MAX_ATTEMPTS tentativas e fora da espera do backoff, #66). Não é elegível:
 * a linha ok (AC-6), a esgotada, a que está na espera e a que tem pedido da gaveta em andamento (#130).
 *
 * AC-2: a saída fora do schema vira erro de formato. AC-3 e AC-4 ficam com a gaveta (readDossier) e com o próprio
 * dossiê, que não tem ação, nível nem valor em risco. AC-5: falha de API, de prazo ou de rede grava `unavailable`
 * com o motivo, e a rede de segurança tenta de novo depois do backoff. Exceção: limite de uso (429) ou credencial
 * recusada (401/403) não gravam linha em claude_suggestions — valem para o lote inteiro, como no laço
 * (`ClaudeError.isGlobal`) —, mas #311 deixam rastro no pedido (status error e o motivo codificado) e o motivo volta a
 * quem despacha, que para o lote. Nunca lança para fora.
 *
 * #311 `pendingId`: o pedido `pending` do backfill desta nota. O disparo o reivindica no lugar de abrir outro (o mesmo
 * custo, um PATCH) e o fecha no fim. Devolve o motivo global da falha, se houve.
 */
export async function generateOnEvent(deps: EventDossierDeps, invoice: InvoiceView, pendingId?: number): Promise<GlobalReason | undefined> {
  const clock = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.error(line));
  const key = invoice.accessKey;
  try {
    if (deps.busy?.has(key)) return undefined;
    const prev = await previousRow(deps.db, key);
    if (prev) {
      if (prev.status === 'ok') return undefined; // #38 AC-6: já há dossiê pronto.
      if (prev.attempts >= MAX_ATTEMPTS) return undefined;
      if (inBackoff(prev, clock())) return undefined;
    }

    // #130 #38 AC-1 A linha em geração é o que a gaveta lê como "Gerando"; fecha no finally, com sucesso ou não.
    const requestId = await begin(deps.requests, key, pendingId, clock());
    if (requestId === undefined) return undefined; // #311 Outra invocação reivindicou o pendente.
    // #311 Se a escrita lançar, o pedido fecha em erro de armazenamento, não em done.
    let closing: Closing = { status: 'error', reason: 'storage_failed' };
    let stop: GlobalReason | undefined;
    try {
      ({ closing, stop } = await callAndStore(deps, invoice, prev, clock, log));
    } finally {
      await deps.requests.finish(requestId, clock(), closing);
    }
    return stop;
  } catch (error) {
    log(`#38 dossiê do evento da nota ${key} não gravado: ${storedError(error, deps.secrets)}`);
    return undefined;
  }
}

/** #311 O pedido em geração desta nota: o pendente reivindicado, ou um novo aberto. Nulo se o pendente já é de outro. */
async function begin(requests: DossierRequests, key: string, pendingId: number | undefined, at: Date): Promise<number | undefined> {
  if (pendingId === undefined) {
    return requests.open({ input_key: key, requested_by: 'claude', requested_at: at.toISOString(), trigger: 'event' });
  }
  return (await requests.claim(pendingId, at)) ? pendingId : undefined;
}

type Stored = { readonly closing: Closing; readonly stop?: GlobalReason };

/** #38 Chama o Claude e grava a linha da sugestão (ok ou erro). Lança só falha do banco. */
async function callAndStore(
  deps: EventDossierDeps,
  invoice: InvoiceView,
  prev: Previous | undefined,
  clock: () => Date,
  log: (line: string) => void,
): Promise<Stored> {
  const key = invoice.accessKey;
  const started = clock().getTime();
  let input: DossierInput | Record<string, never> = {};
  let result: { ok: true; output: unknown } | { ok: false; error: unknown };
  let usage: Usage | null = null;
  try {
    if (!deps.askWithUsage) throw new NoCredentialsError();
    input = dossierRequest(invoice, await deps.context(key));
    const answered = await deps.askWithUsage<unknown>(input);
    usage = answered.usage;
    const output = parseDossierOutput(answered.value);
    if (!output) throw new ClaudeError('format', 'dossier: resposta do Claude fora do formato');
    result = { ok: true, output };
  } catch (error) {
    // #38 A falha depois de alguma resposta traz o uso já gasto; antes de qualquer resposta, nulo.
    usage ??= spentUsage(error);
    result = { ok: false, error };
  }
  if (!result.ok && result.error instanceof ClaudeError && result.error.isGlobal) {
    // Limite de uso ou credencial recusada: não grava a sugestão, a próxima rodada repete (como o laço, #171). #311 O pedido guarda o motivo.
    const reason = requestReasonOf(result.error);
    log(`#38 dossiê do evento da nota ${key} adiado: ${storedError(result.error, deps.secrets)}`);
    return { closing: { status: 'error', reason }, ...(isGlobalReason(reason) ? { stop: reason } : {}) };
  }
  await deps.db.upsert(TABLE, [suggestionRow(deps, key, input, result, usage, prev, clock, started)], {
    // #38 AC-6 Sem linha: ignore, para que uma corrida com outro disparo não sobrescreva. Com linha de erro:
    // #38 merge, a retentativa refaz a mesma linha.
    onConflict: 'task,input_key',
    resolution: prev ? 'merge' : 'ignore',
  });
  // #311 O erro que não é global já ficou na sugestão (com o motivo fino); o pedido só diz que fechou sem dossiê.
  return { closing: result.ok ? { status: 'done' } : { status: 'error', reason: 'claude_failed' } };
}

function suggestionRow(
  deps: EventDossierDeps,
  key: string,
  input: DossierInput | Record<string, never>,
  result: { ok: true; output: unknown } | { ok: false; error: unknown },
  usage: Usage | null,
  prev: Previous | undefined,
  clock: () => Date,
  started: number,
): Record<string, unknown> {
  const fields = result.ok
    ? { output: result.output, status: 'ok', error: null, reason: null, attempts: 0 }
    : {
        output: null,
        status: 'error',
        error: storedError(result.error, deps.secrets),
        reason: failureReason(result.error),
        attempts: prev ? prev.attempts + 1 : 1,
      };
  return {
    task: DOSSIER_TASK,
    input_key: key,
    input,
    model: DEFAULT_MODEL,
    updated_at: clock().toISOString(),
    trigger: 'event',
    latency_ms: clock().getTime() - started,
    usage,
    ...fields,
  };
}
