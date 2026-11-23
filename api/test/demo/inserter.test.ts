import { describe, expect, it } from 'vitest';
import { SupabaseRest, type FetchFn } from '../../src/connectors/supabase-rest.js';
import { DemoInsertError, DemoNoteInserter, INSERT_FUNCTION } from '../../src/demo/inserter.js';
import { generateDemoBatch } from '../../src/demo/generator.js';

const SECRET = 'sb_secret_chave-que-nunca-sai';
const PROVIDER_TEXT = 'permission denied for table kit_notas role service_role';
const batch = generateDemoBatch({ seed: 3, count: 6, now: new Date('2026-11-23T12:00:00Z'), sequenceStart: 1 });

type Call = { url: string; method: string | undefined; body: unknown; headers: Record<string, string> };

function inserterWith(respond: (call: Call) => Response | Promise<Response>): { inserter: DemoNoteInserter; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchFn = async (url, init) => {
    const call: Call = {
      url,
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return respond(call);
  };
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: SECRET, fetch });
  return { inserter: new DemoNoteInserter(rest), calls };
}

const ok = (n: number) => () => new Response(String(n), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('#349 gravação do lote da demonstração', () => {
  it('grava o lote inteiro em uma única requisição rpc e devolve quantas notas entraram', async () => {
    const { inserter, calls } = inserterWith(ok(6));
    await expect(inserter.insert(batch.rows)).resolves.toBe(6);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://fake.supabase.co/rest/v1/rpc/${INSERT_FUNCTION}`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ p_batch: JSON.parse(JSON.stringify(batch.rows)) });
  });

  it('o corpo leva as linhas e nenhuma classificação esperada', async () => {
    const { inserter, calls } = inserterWith(ok(6));
    await inserter.insert(batch.rows);
    const text = JSON.stringify(calls[0]?.body).toLowerCase();
    expect(text).not.toContain('classification');
    expect(text).not.toContain('expected');
    expect(text).toContain('"origin":"demo"');
  });

  it('uma resposta que não é um número inteiro é recusada', async () => {
    const { inserter } = inserterWith(() => new Response('"talvez"', { status: 200 }));
    await expect(inserter.insert(batch.rows)).rejects.toBeInstanceOf(DemoInsertError);
  });

  it('o erro do banco não leva a chave nem o texto do provedor: só a operação, o status e o código', async () => {
    const body = JSON.stringify({ code: '42501', message: PROVIDER_TEXT, hint: SECRET });
    const { inserter } = inserterWith(() => new Response(body, { status: 403 }));
    const error = await inserter.insert(batch.rows).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DemoInsertError);
    const failure = error as DemoInsertError;
    expect([failure.operation, failure.status, failure.code]).toEqual(['rpc', 403, '42501']);
    for (const text of [failure.message, String(failure.stack), JSON.stringify(failure), String(failure.cause ?? '')]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(PROVIDER_TEXT);
    }
  });

  it('a falha de rede também sai sem a chave', async () => {
    const { inserter } = inserterWith(() => {
      throw new Error(`conexão recusada com ${SECRET}`);
    });
    const error = await inserter.insert(batch.rows).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DemoInsertError);
    expect(String((error as Error).message) + String((error as Error).stack)).not.toContain(SECRET);
  });
});
