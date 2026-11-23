import { describe, expect, it } from 'vitest';
import { SupabaseRest, type FetchFn } from '../../src/connectors/supabase-rest.js';
import { DEMO_NOTES_STEP_COST, runDemoNotesRound } from '../../src/demo/round-step.js';

const NOW = new Date('2026-11-23T12:00:00Z');

function world(lastNoteId: string | null) {
  const calls: { url: string; method: string | undefined }[] = [];
  const bodies: unknown[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, method: init?.method });
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
    if (url.includes('/rpc/')) return new Response('5', { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(lastNoteId ? [{ nota_id: lastNoteId }] : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { rest: new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'k', fetch }), calls, bodies };
}

function notaIds(bodies: readonly unknown[]): string[] {
  const body = bodies[0] as { p_batch: { kit_notas: { nota_id: string }[] } };
  return body.p_batch.kit_notas.map((n) => n.nota_id);
}

describe('#349 o passo das notas da demonstração na rodada', () => {
  it('desligado, não faz nenhuma requisição e captura 0', async () => {
    const { rest, calls } = world(null);
    await expect(runDemoNotesRound({ rest, enabled: false, now: NOW })).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('ligado, lê a última nota demo e grava o lote em uma rpc: 2 requisições, o custo declarado', async () => {
    const { rest, calls } = world('DM-00012');
    await expect(runDemoNotesRound({ rest, enabled: true, now: NOW })).resolves.toBe(5);
    expect(calls).toHaveLength(2);
    expect(calls).toHaveLength(DEMO_NOTES_STEP_COST);
    expect(calls[0]?.url).toContain('origin=eq.demo');
    expect(calls[1]?.url).toContain('/rpc/kit_insert_demo_batch');
  });

  it('sem nota demo ainda, começa na sequência 1, e a sequência segue a última nota', async () => {
    const first = world(null);
    await runDemoNotesRound({ rest: first.rest, enabled: true, now: NOW });
    const later = world('DM-00012');
    await runDemoNotesRound({ rest: later.rest, enabled: true, now: NOW });
    expect(notaIds(first.bodies)).toEqual(expect.arrayContaining(['DM-00001']));
    expect(notaIds(first.bodies)).not.toContain('DM-00000');
    const ids = notaIds(later.bodies);
    expect(ids).toContain('DM-00013');
    expect(ids).not.toContain('DM-00012');
  });

  it('um id de nota que não é DM-n é erro, nunca um início inventado', async () => {
    const { rest } = world('NF-001');
    await expect(runDemoNotesRound({ rest, enabled: true, now: NOW })).rejects.toThrow();
  });
});
