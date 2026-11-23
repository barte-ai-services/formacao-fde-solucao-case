// #356 AC-4 O medidor real da rodada: um fetch contado por rodada, que corta a rodada no limite de tempo e de contagem.
import { describe, expect, it } from 'vitest';
import { ROUND_LIMIT_MS } from '../../src/automation/round-budget.js';
import type { FetchFn } from '../../src/connectors/supabase-rest.js';
import type { Env } from '../../src/env.js';
import { FINISH_RESERVE, startRoundMeter } from '../../src/cron/round-meter.js';
import { SUBREQUEST_CAP } from '../../src/cron/subrequests.js';
import { fakeAi } from '../support/fake-ai.js';

function world() {
  let now = 0;
  const reached: string[] = [];
  const fetchFn: FetchFn = async (input) => {
    reached.push(String(input));
    return new Response('{}', { status: 200 });
  };
  const aiCalls: unknown[] = [];
  const ai = fakeAi(async (model, input) => { aiCalls.push([model, input]); return { response: 'ok' }; });
  const env: Env = { ai };
  const meter = () => startRoundMeter(env, { now: () => now, fetch: fetchFn });
  return { reached, aiCalls, env, meter, fetchFn, advance: (ms: number) => { now += ms; } };
}

describe('#356/AC-4 o gasto medido, fetch a fetch', () => { // ADR-002
  it('começa em zero e conta cada fetch do medidor, o que deu certo e o que falhou', async () => { // ADR-002
    const w = world();
    const meter = w.meter();
    expect(meter.spent()).toBe(0);
    await meter.fetch('https://a.test');
    await meter.fetch('https://b.test');
    expect(meter.spent()).toBe(2);
    const broken = startRoundMeter({}, { now: () => 0, fetch: async () => { throw new TypeError('rede fora'); } });
    await expect(broken.fetch('https://c.test')).rejects.toThrow(TypeError);
    expect(broken.spent()).toBe(1);
  });

  it('conta o ai.run do Workers AI na mesma conta, e entrega o resultado do binding', async () => { // ADR-002
    const w = world();
    const meter = w.meter();
    await meter.fetch('https://a.test');
    const result = await meter.env.ai?.run('@cf/modelo' as never, { prompt: 'x' } as never);
    expect(result).toEqual({ response: 'ok' });
    expect(w.aiCalls).toEqual([['@cf/modelo', { prompt: 'x' }]]);
    expect(meter.spent()).toBe(2);
    expect(w.env.ai).toBeDefined(); // #356 AC-4 o env original não muda
  });

  it('sem o binding do Workers AI, o env segue sem ele', () => { // ADR-002
    const meter = startRoundMeter({}, { now: () => 0, fetch: world().fetchFn });
    expect(meter.env.ai).toBeUndefined();
  });

  it('sem fetch dado, usa o fetch global na hora da chamada, sem trocá-lo', async () => { // ADR-002
    const before = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string) => { seen.push(String(input)); return new Response('{}'); }) as typeof fetch;
    const stubbed = globalThis.fetch;
    try {
      const meter = startRoundMeter({}, { now: () => 0 });
      await meter.fetch('https://global.test');
      expect(seen).toEqual(['https://global.test']);
      expect(globalThis.fetch).toBe(stubbed);
    } finally {
      globalThis.fetch = before;
    }
  });
});

describe('#356/AC-4 duas rodadas na mesma invocação não se enxergam', () => { // ADR-002
  it('cada medidor conta só o seu fetch e o fetch global não é tocado', async () => { // ADR-002
    const before = globalThis.fetch;
    const a = world();
    const b = world();
    const ma = a.meter();
    const mb = b.meter();
    await ma.fetch('https://a.test');
    await ma.fetch('https://a2.test');
    await mb.fetch('https://b.test');
    expect(ma.spent()).toBe(2);
    expect(mb.spent()).toBe(1);
    expect(a.reached).toEqual(['https://a.test', 'https://a2.test']);
    expect(b.reached).toEqual(['https://b.test']);
    expect(globalThis.fetch).toBe(before);
  });

  it('o prazo vencido de uma rodada não recusa o fetch da outra', async () => { // ADR-002
    const old = world();
    const fresh = world();
    const mOld = old.meter();
    old.advance(ROUND_LIMIT_MS);
    const mFresh = fresh.meter();
    await expect(mOld.fetch('https://velha.test')).rejects.toThrow(/prazo da rodada/);
    await mFresh.fetch('https://nova.test');
    expect(fresh.reached).toEqual(['https://nova.test']);
  });
});

describe('#356/AC-3 o limite real de duração da rodada', () => { // ADR-002
  it('passado o limite, nenhum fetch novo sai: falha na hora, sem chamar a rede e sem dado no erro', async () => { // ADR-002
    const w = world();
    const meter = w.meter();
    await meter.fetch('https://antes.test');
    w.advance(ROUND_LIMIT_MS);
    const error = await meter.fetch('https://depois.test?chave=segredo').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('RoundLimitError');
    expect(String((error as Error).message)).not.toContain('segredo');
    expect(w.reached).toEqual(['https://antes.test']);
    expect(meter.spent()).toBe(1);
  });

  it('o ai.run também é cortado depois do limite', async () => { // ADR-002
    const w = world();
    const meter = w.meter();
    w.advance(ROUND_LIMIT_MS + 1);
    await expect(meter.env.ai?.run('@cf/modelo' as never, {} as never)).rejects.toThrow(/prazo da rodada/);
    expect(w.aiCalls).toEqual([]);
  });

  it('um instante antes do limite ainda deixa sair', async () => { // ADR-002
    const w = world();
    const meter = w.meter();
    w.advance(ROUND_LIMIT_MS - 1);
    await meter.fetch('https://ainda.test');
    expect(w.reached).toEqual(['https://ainda.test']);
  });

  it('o fetch da reserva não tem corte de tempo: a gravação e a soltura da própria rodada ainda saem', async () => { // ADR-002
    const w = world();
    const meter = w.meter();
    w.advance(ROUND_LIMIT_MS + 1);
    await expect(meter.fetch('https://passo.test')).rejects.toThrow(/prazo da rodada/);
    await meter.reservedFetch('https://gravar.test');
    await meter.reservedFetch('https://soltar.test');
    expect(w.reached).toEqual(['https://gravar.test', 'https://soltar.test']);
    expect(meter.spent()).toBe(2);
  });

  it('a chamada cortada pelo tempo conta como recusada, e a que passou, não', async () => { // ADR-002
    const w = world();
    const meter = w.meter();
    await meter.fetch('https://antes.test');
    expect(meter.refused()).toBe(0);
    w.advance(ROUND_LIMIT_MS);
    await meter.fetch('https://depois.test').catch(() => undefined);
    expect(meter.refused()).toBe(1);
  });
});

describe('#356/AC-4 o teto de contagem da fase dos passos, no contador da #311', () => { // ADR-002
  const steps = SUBREQUEST_CAP - FINISH_RESERVE;

  it('o teto da gravação e da soltura é o do contador da #311: 50, com a reserva de 3 que só o fetch da reserva gasta', () => { // ADR-002
    expect(SUBREQUEST_CAP).toBe(50);
    expect(FINISH_RESERVE).toBe(3); // #356 AC-4 o insert, o reenvio sem as colunas novas (#311) e a soltura da trava
  });

  it('recusa o fetch dos passos quando a contagem chega a 47, guardando a reserva, sem chamar a rede e sem dado no erro', async () => { // ADR-002
    const w = world();
    const meter = w.meter();
    for (let i = 0; i < steps; i += 1) await meter.fetch(`https://${i}.test`);
    const error = await meter.fetch('https://a-mais.test?chave=segredo').catch((e: unknown) => e);
    expect((error as Error).name).toBe('SubrequestBudgetError');
    expect(String((error as Error).message)).not.toContain('segredo');
    expect(w.reached).toHaveLength(steps);
    expect(meter.spent()).toBe(steps);
    expect(meter.refused()).toBe(1);
  });

  it('o ai.run também respeita o teto de contagem e entra na mesma conta', async () => { // ADR-002
    const w = world();
    const meter = w.meter();
    for (let i = 0; i < steps - 1; i += 1) await meter.fetch(`https://${i}.test`);
    await meter.env.ai?.run('@cf/modelo' as never, {} as never);
    expect(meter.spent()).toBe(steps);
    await expect(meter.env.ai?.run('@cf/modelo' as never, {} as never)).rejects.toThrow(/subrequests/);
    expect(w.aiCalls).toHaveLength(1);
  });

  it('com o teto dos passos cheio, o fetch da reserva ainda grava, reenvia e solta, e para no 50', async () => { // ADR-002
    const w = world();
    const meter = w.meter();
    for (let i = 0; i < steps; i += 1) await meter.fetch(`https://${i}.test`);
    for (let i = 0; i < FINISH_RESERVE; i += 1) await meter.reservedFetch(`https://reserva-${i}.test`);
    expect(meter.spent()).toBe(SUBREQUEST_CAP);
    await expect(meter.reservedFetch('https://passa-do-teto.test')).rejects.toThrow(/subrequests/);
    expect(meter.spent()).toBe(SUBREQUEST_CAP);
  });

  it('é um medidor só: o contador da #311 é quem conta, e measureOnly só conta, sem teto nem corte de tempo', async () => { // ADR-002
    const w = world();
    const free = startRoundMeter(w.env, { now: () => 0, fetch: w.fetchFn, measureOnly: true });
    for (let i = 0; i < SUBREQUEST_CAP + 5; i += 1) await free.fetch(`https://${i}.test`);
    expect(free.spent()).toBe(SUBREQUEST_CAP + 5);
    expect(free.refused()).toBe(0);
  });
});
