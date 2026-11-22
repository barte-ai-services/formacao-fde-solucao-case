// #311 O teto de subrequests de uma invocação do Worker (plano gratuito: 50): o fetch que conta cada chamada, PostgREST e
// Messages API juntas, e lança a partir da 51ª, como o runtime faz.
import type { FetchFn } from '../../src/connectors/supabase-rest.js';

export const SUBREQUEST_CAP = 50;

export type SubrequestCounter = {
  readonly fetch: FetchFn;
  /** #311 As subrequests tentadas até agora (inclui as que passaram do teto e lançaram). */
  count(): number;
  /** #311 Método, tabela ou host de cada subrequest, na ordem, sem corpo nem cabeçalho. */
  trail(): string[];
};

export function countSubrequests(inner: FetchFn, cap = SUBREQUEST_CAP): SubrequestCounter {
  const trail: string[] = [];
  const fetch: FetchFn = async (input, init) => {
    const url = new URL(String(input));
    trail.push(`${init?.method ?? 'GET'} ${url.hostname === 'api.anthropic.com' ? 'anthropic' : url.pathname.replace(/^\/rest\/v1\//, '')}`);
    if (trail.length > cap) throw new Error('Too many subrequests');
    return inner(String(input), init);
  };
  return { fetch, count: () => trail.length, trail: () => [...trail] };
}
