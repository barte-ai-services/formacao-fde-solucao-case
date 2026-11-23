// #356 AC-2 A conta da rodada manual (cron/manual-window.ts) e o executor que adia, não falha, o passo que o tempo não deixou começar.
import { describe, expect, it } from 'vitest';
import { executeRound, type RoundStep } from '../../src/automation/round-budget.js';
import { MANUAL_WORST_CASE_MS, WAIT_UNTIL_MS } from '../../src/cron/manual-window.js';

describe('#356/AC-2 a janela da rodada manual', () => {
  it('#356/AC-2 o pior caso (limite, maior fetch em curso, gravação e soltura) fica abaixo da vida do waitUntil, com folga', () => {
    expect(MANUAL_WORST_CASE_MS).toBeLessThan(WAIT_UNTIL_MS);
    expect(WAIT_UNTIL_MS - MANUAL_WORST_CASE_MS).toBeGreaterThanOrEqual(3_000);
  });

  it('#356/AC-2 passado o tempo, o passo que não começou fica adiado (na ordem de espera) e o que já rodou fica rodado', async () => {
    let expired = false;
    const ran: string[] = [];
    const step = (name: string, after?: () => void): RoundStep => ({ name, maxSubrequests: 1, run: async () => { ran.push(name); after?.(); } });
    const steps = [step('a'), step('b', () => { expired = true; }), step('c'), step('d')];
    const outcome = await executeRound(steps, ['d'], undefined, undefined, () => expired);
    expect(ran).toEqual(['a', 'b']);
    expect(outcome.ran).toEqual(['a', 'b']);
    expect(outcome.failed).toEqual([]);
    expect(outcome.deferred).toEqual(['d', 'c']);
  });

  it('#356/AC-2 sem a porta do tempo o executor roda tudo, como o Cron', async () => {
    const steps: RoundStep[] = ['a', 'b'].map((name) => ({ name, maxSubrequests: 1, run: async () => {} }));
    await expect(executeRound(steps, [])).resolves.toMatchObject({ ran: ['a', 'b'], deferred: [] });
  });
});
