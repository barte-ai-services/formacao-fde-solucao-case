// #311 A conta de subrequests de uma invocação do Worker (plano gratuito: 50), contada por injeção do fetch e não por remendo do
// #311 `globalThis.fetch`: o isolate pode atender invocações concorrentes, e cada uma tem o próprio contador.
import type { FetchFn } from '../connectors/supabase-rest.js';

/** #311 O teto de subrequests por invocação do plano gratuito. O Worker é tratado como esse plano (claude/cron.ts). */
export const SUBREQUEST_CAP = 50;

/** #311 O erro de uma chamada recusada aqui, sem chamar o fetch: a invocação já gastou o que podia gastar fora da reserva. */
export class SubrequestBudgetError extends Error {
  constructor() {
    super('orçamento de subrequests esgotado');
    this.name = 'SubrequestBudgetError';
  }
}

/** #311 O orçamento que o contador defende: o teto da invocação e quantas chamadas ficam guardadas para a gravação da rodada. */
export type SubrequestBudget = { readonly cap: number; readonly reserve: number };

export type SubrequestCounter = {
  /** #311 O fetch que o PostgREST e a Messages API recebem: conta cada chamada e repassa; com orçamento, recusa ao invadir a reserva. */
  readonly fetch: FetchFn;
  /** #311 O fetch da gravação da rodada: o único que gasta a reserva, ainda dentro do teto. */
  readonly reservedFetch: FetchFn;
  /** #356 AC-4 Conta uma chamada que não passa por fetch (o `ai.run` do Workers AI) e a recusa como o `fetch` recusaria: lança o mesmo erro. */
  admit(): void;
  count(): number;
  /** #311 Quantas chamadas ainda cabem antes do teto (a reserva incluída); nulo sem orçamento. */
  remaining(): number | null;
  /** #311 Quantas chamadas, ou passos inteiros, foram recusados por falta de orçamento. */
  refused(): number;
  /** #311 true quando o que resta é só a reserva (e registra a recusa de quem perguntou, para o passo que será pulado). */
  deny(): boolean;
};

/**
 * #311 Conta só o que passa por este fetch: o PostgREST (SupabaseRest) e a Messages API (ClaudeClient). O binding do Workers AI do
 * motor não passa por fetch e não entra na conta; o runtime o contabiliza à parte, e o número daqui é o piso.
 * Sem `inner`, repassa ao `fetch` global resolvido a cada chamada. Sem `budget`, só conta; com ele, `fetch` recusa localmente (sem
 * subrequest) a chamada que invadiria a reserva, e `reservedFetch` recusa só a que passaria do teto.
 */
export function countSubrequests(inner?: FetchFn, budget?: SubrequestBudget): SubrequestCounter {
  let calls = 0;
  let refusals = 0;
  const take = (limit: number | undefined): void => {
    if (limit !== undefined && calls >= limit) {
      refusals += 1;
      throw new SubrequestBudgetError();
    }
    calls += 1;
  };
  const through =
    (limit: number | undefined): FetchFn =>
    (input, init) => {
      try {
        take(limit);
      } catch (error) {
        return Promise.reject(error);
      }
      return inner ? inner(input, init) : fetch(input, init);
    };
  const spendable = budget ? budget.cap - budget.reserve : undefined;
  return {
    admit: () => take(spendable),
    fetch: through(spendable),
    reservedFetch: through(budget?.cap),
    count: () => calls,
    remaining: () => (budget ? budget.cap - calls : null),
    refused: () => refusals,
    deny: () => {
      if (spendable === undefined || calls < spendable) return false;
      refusals += 1;
      return true;
    },
  };
}

/** #311 A linha final estável de cada invocação, fácil de achar no `wrangler tail`. `label` diz qual invocação foi. */
export function subrequestsLine(count: number, label: string): string {
  return `cron: subrequests ${count}/${SUBREQUEST_CAP} (${label})`;
}
