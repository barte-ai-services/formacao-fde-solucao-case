// #311 O contador com orçamento: o fetch dos passos recusa, sem subrequest, a chamada que invadiria a reserva; só o da gravação a gasta.
import { describe, expect, it } from 'vitest';
import { countSubrequests, SubrequestBudgetError } from '../../src/cron/subrequests.js';

const ok = async (_input?: string, _init?: RequestInit) => new Response('[]');

describe('#311 o contador com orçamento', () => {
  it('recusa localmente a chamada que invadiria a reserva e deixa a reserva para a gravação', async () => {
    let reached = 0;
    const counter = countSubrequests(async (input, init) => { reached += 1; return ok(input, init); }, { cap: 5, reserve: 2 });

    for (let i = 0; i < 3; i += 1) await counter.fetch('https://x/a');
    await expect(counter.fetch('https://x/a')).rejects.toBeInstanceOf(SubrequestBudgetError);
    expect(counter.deny()).toBe(true);
    expect(counter.remaining()).toBe(2);

    await counter.reservedFetch('https://x/a');
    await counter.reservedFetch('https://x/a');
    await expect(counter.reservedFetch('https://x/a')).rejects.toBeInstanceOf(SubrequestBudgetError);
    expect(reached).toBe(5);
    expect(counter.count()).toBe(5);
    expect(counter.refused()).toBe(3);
  });

  it('sem orçamento só conta e nunca recusa', async () => {
    const counter = countSubrequests(ok);
    for (let i = 0; i < 80; i += 1) await counter.fetch('https://x/a');
    expect(counter.count()).toBe(80);
    expect(counter.deny()).toBe(false);
    expect(counter.remaining()).toBeNull();
  });
});
