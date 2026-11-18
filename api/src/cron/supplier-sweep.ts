import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { replyDeps } from '../supplier/supabase-reply-deps.js';
import { createReplyUseCases } from '../supplier/reply-use-cases.js';
import type { Clock } from '../supplier/reply-ports.js';

// #157 (#157): a varredura do prazo no Cron. É determinística (sem Claude): roda mesmo sem credencial, e o pedido
// #157 enviado sem leitura depois do prazo vira no_reply com follow_up. #157: a cobrança é montada aqui mesmo, pela regra, sem o Claude, e só uma pessoa a envia (#157).

/**
 * #157: pedidos tratados por rodada. Cada pedido marcado custa 2 subrequests (a gravação da leitura e a releitura que
 * #157: diz se outra a vence) e, desde a #157, mais 2 do rascunho da cobrança (a leitura da linha e a gravação guardada); a varredura
 * #157: lê 2 vezes antes (os pedidos enviados e as notas deles): 2 + 4 × 1 = 6 (conta em api/src/claude/cron.ts).
 */
export const SUPPLIER_SWEEP_PER_ROUND = 1;

/** #157: marca os atrasados do dia de hoje (em São Paulo, pelo caso de uso) e monta a cobrança de cada um (#157), até o teto da rodada; devolve quantos marcou e quantas cobranças montou. */
export async function sweepSupplierOverdue(rest: SupabaseRest, clock: Clock = { now: () => new Date() }): Promise<{ readonly marked: number; readonly drafted: number }> {
  const { marked, drafted } = await createReplyUseCases(replyDeps(rest, { clock })).sweepOverdue(SUPPLIER_SWEEP_PER_ROUND);
  return { marked: marked.length, drafted: drafted.length };
}
