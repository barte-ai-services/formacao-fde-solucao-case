// #311 A conta de subrequests de uma invocação do Worker (plano gratuito: 50), contada por injeção do fetch e não por remendo do
// #311 `globalThis.fetch`: o isolate pode atender invocações concorrentes, e cada uma tem o próprio contador.
import type { FetchFn } from '../connectors/supabase-rest.js';

/** #311 O teto de subrequests por invocação do plano gratuito. O Worker é tratado como esse plano (claude/cron.ts). */
export const SUBREQUEST_CAP = 50;

export type SubrequestCounter = {
  /** #311 O fetch que o PostgREST e a Messages API recebem: conta cada chamada tentada (as que lançam também) e repassa. */
  readonly fetch: FetchFn;
  count(): number;
};

/**
 * #311 Conta só o que passa por este fetch: o PostgREST (SupabaseRest) e a Messages API (ClaudeClient). O binding do Workers AI do
 * motor não passa por fetch e não entra na conta; o runtime o contabiliza à parte, e o número daqui é o piso.
 * Sem `inner`, repassa ao `fetch` global resolvido a cada chamada.
 */
export function countSubrequests(inner?: FetchFn): SubrequestCounter {
  let calls = 0;
  return {
    fetch: (input, init) => {
      calls += 1;
      return inner ? inner(input, init) : fetch(input, init);
    },
    count: () => calls,
  };
}

/** #311 A linha final estável de cada invocação, fácil de achar no `wrangler tail`. `label` diz qual invocação foi. */
export function subrequestsLine(count: number, label: string): string {
  return `cron: subrequests ${count}/${SUBREQUEST_CAP} (${label})`;
}
