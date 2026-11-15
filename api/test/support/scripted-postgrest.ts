// #230 Um PostgREST roteirizado: cada requisição é registrada (método, tabela, parâmetros, corpo) e respondida
// #230 por uma função do teste. Serve para afirmar as requisições exatas, o que o fake em memória não mostra.
import { SupabaseRest, type FetchFn } from '../../src/connectors/supabase-rest.js';

export type Call = {
  method: string;
  table: string;
  params: URLSearchParams;
  body: unknown;
  prefer: string;
};

export type Reply = { status?: number; body: unknown };

export function scripted(respond: (call: Call) => Reply = () => ({ body: [] })): { rest: SupabaseRest; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchFn = async (input, init = {}) => {
    const url = new URL(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init.method ?? 'GET',
      table: url.pathname.replace(/^\/rest\/v1\//, ''),
      params: url.searchParams,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      prefer: headers.Prefer ?? '',
    };
    calls.push(call);
    const reply = respond(call);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch });
  return { rest, calls };
}
