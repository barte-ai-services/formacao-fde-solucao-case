// #130 O dossiê pedido na gaveta: o mesmo agente da #38, disparado pela pessoa para uma proposta só.
// #130 Roda depois do 202, pelo waitUntil do Worker. Nunca lança: qualquer falha vira linha de erro (ou mantém o
// dossiê pronto anterior, AC-4) e o pedido sempre fecha em dossier_requests.
import {
  ClaudeClient,
  ClaudeError,
  DEFAULT_MODEL,
  spentUsage,
  type AskWithUsage,
  type ClaudeCredentials,
  type FetchFn,
  type Usage,
} from '../claude/client.js';
import type { Db } from '../claude/db.js';
import { storedError } from '../claude/runner.js';
import { dossierRequest, failureReason, parseDossierOutput, type DossierInput } from '../claude/tasks/dossier.js';
import type { CheckContext, InvoiceView } from '../domain/index.js';
import type { DossierRequests } from './requests.js';
import { DOSSIER_TASK } from './source.js';

const TABLE = 'claude_suggestions';

/**
 * #130 Prazo da pergunta sob demanda. O Worker mantém o waitUntil vivo só uns 30 s depois da resposta; com os
 * 45 s do Cron (ASK_TIMEOUT_MS) o Worker cortaria o trabalho antes, o `finally` não rodaria e o pedido ficaria
 * aberto (Gerando e 409 por 5 min). Com 20 s sobra margem para ler o contexto antes e gravar a linha depois, e a
 * resposta atrasada vira erro `timeout` gravado, com o pedido fechado.
 */
export const ON_DEMAND_ASK_TIMEOUT_MS = 20_000;

/**
 * #130 O Claude da geração do dossiê, com o prazo que cabe no waitUntil. #38 Devolve também o uso de tokens, que
 * o sob demanda e o evento gravam em claude_suggestions.usage.
 */
export function onDemandAskWithUsage(
  credentials: ClaudeCredentials,
  options: { readonly fetch?: FetchFn; readonly timeoutMs?: number } = {},
): AskWithUsage {
  return new ClaudeClient({ credentials, fetch: options.fetch, timeoutMs: options.timeoutMs ?? ON_DEMAND_ASK_TIMEOUT_MS })
    .askWithUsage;
}

/** #130 O que a geração sob demanda precisa; tudo injetável nos testes. */
export type OnDemandDeps = {
  /** #130 O banco das sugestões, o mesmo Db do laço (#66). */
  readonly db: Db;
  readonly requests: DossierRequests;
  /** #130 O contexto da nota, como a gaveta e a tarefa montam (#68). */
  readonly context: (invoiceAccessKey: string) => Promise<CheckContext>;
  /**
   * #130 Sem credencial do Claude, undefined: a geração fecha em erro `claude_failed`. #38 Com o uso de tokens e
   * obrigatório no tipo (undefined explícito): esquecer a ligação em index.ts quebra o tsc.
   */
  readonly askWithUsage: AskWithUsage | undefined;
  /** #130 Valores que nunca entram na coluna error (o token, a chave do Supabase). */
  readonly secrets?: readonly string[];
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
};

export type OnDemandRequest = {
  readonly invoiceAccessKey: string;
  readonly invoice: InvoiceView;
  readonly requestedBy: string;
  readonly requestedAt: string;
  /** #130 O id do pedido aberto em dossier_requests: é ele, e só ele, que fecha no fim. */
  readonly requestId?: number;
};

type Previous = { readonly status: string; readonly attempts: number };

async function previousRow(db: Db, key: string): Promise<Previous | undefined> {
  const rows = await db.select(TABLE, {
    select: 'status,attempts',
    filters: { task: `eq.${DOSSIER_TASK}`, input_key: `eq.${key}` },
    order: 'input_key.asc',
  });
  const [first] = rows as { status?: unknown; attempts?: unknown }[];
  if (!first || typeof first.status !== 'string') return undefined;
  return { status: first.status, attempts: typeof first.attempts === 'number' ? first.attempts : 0 };
}

/**
 * #130 Gera o dossiê de uma nota e grava em claude_suggestions com `trigger = on_demand`. AC-4: se falhar e já
 * houver um dossiê `ok`, o anterior fica como está. Sempre fecha o pedido em dossier_requests.
 */
export async function generateOnDemand(deps: OnDemandDeps, request: OnDemandRequest): Promise<void> {
  const clock = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.error(line));
  const key = request.invoiceAccessKey;
  try {
    const started = clock().getTime();
    let input: DossierInput | Record<string, never> = {};
    let result: { ok: true; output: unknown } | { ok: false; error: unknown };
    let usage: Usage | null = null;
    try {
      if (!deps.askWithUsage) throw new ClaudeError('auth', 'sem credencial do Claude no Worker');
      input = dossierRequest(request.invoice, await deps.context(key));
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
    const latencyMs = clock().getTime() - started;
    const previous = await previousRow(deps.db, key);
    if (!result.ok && previous?.status === 'ok') {
      // #130 AC-4: o dossiê pronto continua; a falha fica só no log.
      log(`#130 dossiê sob demanda da nota ${key} falhou (${failureReason(result.error)}); o anterior continua`);
    } else {
      const attempts = previous?.attempts ?? 0;
      const fields = result.ok
        ? { output: result.output, status: 'ok', error: null, reason: null, attempts: 0 }
        : {
            output: null,
            status: 'error',
            error: storedError(result.error, deps.secrets),
            reason: failureReason(result.error),
            attempts: attempts + 1,
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
            trigger: 'on_demand',
            requested_by: request.requestedBy,
            requested_at: request.requestedAt,
            latency_ms: latencyMs,
            usage,
            ...fields,
          },
        ],
        { onConflict: 'task,input_key', resolution: 'merge' },
      );
    }
  } catch (error) {
    log(`#130 dossiê sob demanda da nota ${key} não gravado: ${storedError(error, deps.secrets)}`);
  } finally {
    try {
      if (request.requestId !== undefined) await deps.requests.finish(request.requestId, clock());
    } catch (error) {
      // #130 O pedido aberto vira abandonado em IN_FLIGHT_MS; a gaveta para de mostrar Gerando sozinha.
      log(`#130 pedido do dossiê da nota ${key} não fechado: ${storedError(error, deps.secrets)}`);
    }
  }
}
