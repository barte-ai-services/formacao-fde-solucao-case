// #38 O dossiê disparado pelo evento: a proposta que acabou de virar `aguardando_aprovacao` (approval/propose-checked.ts),
// e, no mesmo tick, as que ficaram sem dossiê por causa do teto ou de uma falha anterior (cron/tick.ts). Quem chama
// agenda esta promise fora da resposta do Cron (defer/waitUntil). Não há rodada agendada do laço de tarefas (#66/#171).
import { inBackoff } from '../claude/runner.js';
import { ClaudeError, DEFAULT_MODEL, spentUsage, type AskWithUsage, type Usage } from '../claude/client.js';
import type { Db } from '../claude/db.js';
import { MAX_ATTEMPTS, storedError } from '../claude/runner.js';
import { dossierRequest, failureReason, parseDossierOutput, type DossierInput } from '../claude/tasks/dossier.js';
import type { CheckContext, InvoiceView } from '../domain/index.js';
import { inFlight, IN_FLIGHT_MS, type DossierRequests } from './requests.js';
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
 * #130 As chaves com pedido da gaveta em andamento (aberto há menos de IN_FLIGHT_MS). Uma leitura só, para o tick
 * inteiro: o disparo do evento e a rede de segurança não chamam o Claude para essas chaves.
 */
export async function busyKeys(requests: DossierRequests, now: Date): Promise<Set<string>> {
  const open = await requests.openSince(new Date(now.getTime() - IN_FLIGHT_MS));
  const keys = new Set<string>();
  for (const r of open) if (inFlight([r], now)) keys.add(r.input_key);
  return keys;
}

/**
 * #38 Gera e grava o dossiê de uma proposta que espera uma pessoa. Elegível quando não há linha, ou quando a linha
 * de erro já pode ser refeita (menos de MAX_ATTEMPTS tentativas e fora da espera do backoff, #66). Não é elegível:
 * a linha ok (AC-6), a esgotada, a que está na espera e a que tem pedido da gaveta em andamento (#130).
 *
 * AC-2: a saída fora do schema vira erro de formato. AC-3 e AC-4 ficam com a gaveta (readDossier) e com o próprio
 * dossiê, que não tem ação, nível nem valor em risco. AC-5: falha de API, de prazo ou de rede grava `unavailable`
 * com o motivo, e a rede de segurança tenta de novo depois do backoff. Exceção: limite de uso (429) ou credencial
 * recusada (401/403) não gravam linha — valem para o tick inteiro, como no laço (`ClaudeError.isGlobal`); a
 * proposta fica sem linha e a próxima rodada tenta de novo. Nunca lança para fora.
 */
export async function generateOnEvent(deps: EventDossierDeps, invoice: InvoiceView): Promise<void> {
  const clock = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.error(line));
  const key = invoice.accessKey;
  try {
    if (deps.busy?.has(key)) return;
    const prev = await previousRow(deps.db, key);
    if (prev) {
      if (prev.status === 'ok') return; // AC-6: já há dossiê pronto.
      if (prev.attempts >= MAX_ATTEMPTS) return;
      if (inBackoff(prev, clock())) return;
    }

    // #130 #38 AC-1 A linha aberta é o que a gaveta lê como "Gerando"; fecha no finally, com sucesso ou não.
    const requestId = await deps.requests.open({ input_key: key, requested_by: 'claude', requested_at: clock().toISOString(), trigger: 'event' });
    try {
      await callAndStore(deps, invoice, prev, clock, log);
    } finally {
      await deps.requests.finish(requestId, clock());
    }
  } catch (error) {
    log(`#38 dossiê do evento da nota ${key} não gravado: ${storedError(error, deps.secrets)}`);
  }
}

/** #38 Chama o Claude e grava a linha da sugestão (ok ou erro). Lança só falha do banco. */
async function callAndStore(
  deps: EventDossierDeps,
  invoice: InvoiceView,
  prev: Previous | undefined,
  clock: () => Date,
  log: (line: string) => void,
): Promise<void> {
  const key = invoice.accessKey;
  {
    const started = clock().getTime();
    let input: DossierInput | Record<string, never> = {};
    let result: { ok: true; output: unknown } | { ok: false; error: unknown };
    let usage: Usage | null = null;
    try {
      if (!deps.askWithUsage) throw new ClaudeError('auth', 'sem credencial do Claude no Worker');
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
      // Limite de uso ou credencial recusada: não grava linha, a próxima rodada repete (como o laço, #171).
      log(`#38 dossiê do evento da nota ${key} adiado: ${storedError(result.error, deps.secrets)}`);
      return;
    }
    const latencyMs = clock().getTime() - started;
    const attempts = prev ? prev.attempts + 1 : 1;
    const fields = result.ok
      ? { output: result.output, status: 'ok', error: null, reason: null, attempts: 0 }
      : {
          output: null,
          status: 'error',
          error: storedError(result.error, deps.secrets),
          reason: failureReason(result.error),
          attempts,
        };
    await deps.db.upsert(
      TABLE,
      [
        {
          task: DOSSIER_TASK,
          input_key: key,
          input,
          model: DEFAULT_MODEL,
          updated_at: clock().toISOString(),
          trigger: 'event',
          latency_ms: latencyMs,
          usage,
          ...fields,
        },
      ],
      // Sem linha: ignore, para que uma corrida com outro disparo não sobrescreva (AC-6). Com linha de erro:
      // merge, a retentativa refaz a mesma linha.
      { onConflict: 'task,input_key', resolution: prev ? 'merge' : 'ignore' },
    );
  }
}
