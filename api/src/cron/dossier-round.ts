// #311 A invocação própria do dossiê (o terceiro cron de api/wrangler.jsonc, src/cron/schedule.ts). O dossiê saiu do tick de
// 15 minutos porque o tick já passa dos 50 subrequests antes de chegar nele (a causa da #311): aqui ele tem o teto só para si.
import { credentialsFromEnv, type ClaudeCredentials } from '../claude/client.js';
import { restDb } from '../claude/db.js';
import { keyStates, type KeyState } from '../claude/runner.js';
import { needsDossier } from '../claude/tasks/dossier.js';
import { SupabaseApprovalStore } from '../approval/supabase-store.js';
import type { CaptureDeps } from './capture.js';
import { SupabaseRest, SupabaseRestError } from '../connectors/supabase-rest.js';
import type { InvoiceView } from '../domain/invoice.js';
import { loadDossierContext } from '../dossier/context.js';
import { busyKeysOf, generateOnEvent } from '../dossier/event.js';
import { onDemandAskWithUsage } from '../dossier/on-demand.js';
import { isGlobalReason, SupabaseDossierRequests, type DossierRequest, type GlobalReason } from '../dossier/requests.js';
import { DOSSIER_TASK } from '../dossier/source.js';
import type { Env } from '../env.js';

/**
 * #38 #311 Teto de disparos do dossiê por invocação. A conta, contada fetch a fetch (api/test/cron/dossier-budget.test.ts), contra os 50 subrequests:
 * leituras 8 (os pedidos da janela 1, as sugestões do dossiê 1, as propostas que esperam 6) + o contexto do dossiê 13 (lido uma vez, no primeiro
 * disparo; medido, eram 13 leituras dos conectores e não as 7 que o comentário antigo dizia) + por disparo 5 (a linha anterior, a reivindicação ou
 * o `open` do pedido, a pergunta ao Claude, a gravação da linha, o fim do pedido). A pergunta ao Claude é uma volta só (sem tools, `maxTurns` 1 em
 * claude/client.ts). Com 5: 8 + 13 + 25 = 46; fechar pendentes que perderam o sentido custa até 3 PATCH, 49. Com 6 seriam 52 e passariam do teto.
 * Cada leitura de lista passa de 1000 linhas ganha uma página a mais (supabase-rest): a conta vale enquanto a tabela lida tem menos que isso.
 * O que passar do teto não fica esquecido: a próxima invocação (a cada 15 minutos) pega.
 */
export const DOSSIER_EVENT_LIMIT = 5;

/**
 * #311 AC-3 Depois de um erro global do Claude (429, 401/403, ou sem credencial), a próxima invocação só tenta de novo passado este
 * tempo. A janela é a da leitura dos pedidos (a mesma única leitura), que vê o erro gravado em dossier_requests.
 */
export const DOSSIER_GLOBAL_BACKOFF_MS = 30 * 60_000;

/** #311 O motivo global ainda dentro do backoff, se houver. `no_credentials` só vale enquanto a credencial continua faltando: posta a credencial, tenta já. */
function activeBackoff(window: readonly DossierRequest[], now: Date, hasCredentials: boolean): GlobalReason | undefined {
  const since = now.getTime() - DOSSIER_GLOBAL_BACKOFF_MS;
  for (const r of window) {
    if (r.status !== 'error' || !isGlobalReason(r.reason) || Date.parse(r.requested_at) < since) continue;
    if (r.reason === 'no_credentials' && hasCredentials) continue;
    return r.reason;
  }
  return undefined;
}

/**
 * #38 AC-1 e AC-5, #311 Gera o dossiê das propostas que esperam uma pessoa e ainda não têm dossiê pronto, em sequência: cada disparo
 * é esperado (nada de `waitUntil`), para parar o lote no primeiro erro global. Primeiro os pedidos `pending` do backfill, depois as
 * demais pela ordem em que esperam. Não dispara o que tem linha ok, esgotada ou em espera do backoff, nem o que tem pedido em andamento
 * (`running`, #130). No máximo DOSSIER_EVENT_LIMIT por invocação: sem loop.
 *
 * Sem credencial do Claude no Worker: uma linha `error`/`no_credentials` por chave do lote, num insert só, e nenhuma chamada.
 * Falha de leitura ou de escrita aqui é registrada, só com o status ou a classe do erro, e não quebra a invocação.
 */
export async function dispatchDossiers(env: Env, rest: SupabaseRest, captureDeps: CaptureDeps): Promise<void> {
  try {
    const now = new Date();
    const credentials = credentialsFromEnv(env);
    const requests = new SupabaseDossierRequests(rest);
    const window = await requests.window(new Date(now.getTime() - DOSSIER_GLOBAL_BACKOFF_MS));
    const waiting = activeBackoff(window, now, credentials !== undefined);
    if (waiting) {
      console.log(`cron: dossiês em espera do backoff (${waiting}); o Claude não foi chamado nesta invocação`);
      return;
    }
    const db = restDb(rest);
    const [states, awaiting] = await Promise.all([keyStates(db, DOSSIER_TASK, now), new SupabaseApprovalStore(rest).listAwaiting()]);
    const needing = awaiting.filter(needsDossier).map((f) => f.invoice);
    await settleMootPending(requests, window, states, needing, now);

    const pendingIds = new Map(window.filter((r) => r.status === 'pending').map((r) => [r.input_key, r.id]));
    const busy = busyKeysOf(window, now);
    const eligible = needing.filter((i) => !busy.has(i.accessKey) && (!states.has(i.accessKey) || states.get(i.accessKey) === 'retry'));
    const batch = [...eligible.filter((i) => pendingIds.has(i.accessKey)), ...eligible.filter((i) => !pendingIds.has(i.accessKey))].slice(0, DOSSIER_EVENT_LIMIT);
    if (batch.length === 0) return;

    if (!credentials) {
      await requests.recordFailures(batch.map((i) => i.accessKey), now, 'no_credentials');
      console.log(`cron: dossiês não gerados (no_credentials): sem credencial do Claude no Worker; ${batch.length} pedidos registrados em erro`);
      return;
    }
    await generateBatch({ credentials, secretKey: env.BARTE_ACADEMY_SUPABASE_SECRET_KEY, rest, captureDeps, requests }, batch, pendingIds, busy);
  } catch (error) {
    // #311 Só o status ou a classe do erro vão para o log, nunca o texto (pode trazer a resposta do banco).
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : error instanceof Error ? error.name : 'unknown';
    console.log(`cron: dossiês não disparados nesta invocação (falha ${status}); a próxima tenta de novo`);
  }
}

/**
 * #311 AC-4 Fecha, em até três PATCH, os `pending` que já não têm o que fazer: o da nota com dossiê ok (done), o da proposta
 * que deixou de esperar uma pessoa (done, `not_needed`) e o da chave esgotada (MAX_ATTEMPTS erros: error, `claude_failed`,
 * porque ela nunca mais entra no lote). Sem isso o pendente do backfill ficaria na lista do administrador para sempre.
 */
async function settleMootPending(
  requests: SupabaseDossierRequests,
  window: readonly DossierRequest[],
  states: ReadonlyMap<string, KeyState>,
  needing: readonly InvoiceView[],
  now: Date,
): Promise<void> {
  const pending = window.filter((r) => r.status === 'pending').map((r) => r.input_key);
  const needed = new Set(needing.map((i) => i.accessKey));
  const ready = pending.filter((key) => states.get(key) === 'ok');
  const gone = pending.filter((key) => states.get(key) !== 'ok' && !needed.has(key));
  const exhausted = pending.filter((key) => states.get(key) === 'exhausted' && needed.has(key));
  await requests.closePending(ready, now, { status: 'done' });
  await requests.closePending(gone, now, { status: 'done', reason: 'not_needed' });
  await requests.closePending(exhausted, now, { status: 'error', reason: 'claude_failed' });
}

type BatchDeps = {
  readonly credentials: ClaudeCredentials;
  readonly secretKey: string | undefined;
  readonly rest: SupabaseRest;
  readonly captureDeps: CaptureDeps;
  readonly requests: SupabaseDossierRequests;
};

/** #38 O mesmo Claude do sob demanda, com o uso de tokens que vai para a coluna usage; um disparo por vez, parando no primeiro erro global. */
async function generateBatch(
  { credentials, secretKey, rest, captureDeps, requests }: BatchDeps,
  batch: readonly InvoiceView[],
  pendingIds: ReadonlyMap<string, number>,
  busy: ReadonlySet<string>,
): Promise<void> {
  const secret = credentials.kind === 'api-key' ? credentials.apiKey : credentials.token;
  const secrets = [secret, secretKey ?? ''];
  const askWithUsage = onDemandAskWithUsage(credentials);
  const db = restDb(rest);
  // #311 Um contexto só por invocação (13 leituras), lido no primeiro disparo: cada nota sai da própria lista de capturadas.
  let shared: ReturnType<typeof loadDossierContext> | undefined;
  const context = async (key: string) => {
    shared ??= loadDossierContext(captureDeps, '');
    const ctx = await shared;
    return { ...ctx, capturedInvoices: ctx.capturedInvoices.filter((i) => i.accessKey !== key) };
  };
  for (const invoice of batch) {
    const stop = await generateOnEvent({ db, askWithUsage, secrets, busy, context, requests }, invoice, pendingIds.get(invoice.accessKey));
    if (stop) {
      console.log(`cron: dossiês parados no primeiro erro global (${stop}); a próxima invocação respeita o backoff`);
      return;
    }
  }
}
