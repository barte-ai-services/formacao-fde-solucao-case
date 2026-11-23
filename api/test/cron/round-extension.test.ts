// #356 AC-4 O ponto de extensão da lista de passos (#349 notas novas, #351): um passo acrescentado ao fim da lista é planejado
// #356 AC-4 pelo custo declarado, admitido pelo gasto medido e cortado pelo medidor, pelas mesmas regras dos de hoje, sem tocar o executor.
import { describe, expect, it } from 'vitest';
import { executeRound, planRound, STEP_BUDGET, type RoundStep } from '../../src/automation/round-budget.js';
import { FINISH_RESERVE, startRoundMeter } from '../../src/cron/round-meter.js';
import { SUBREQUEST_CAP } from '../../src/cron/subrequests.js';
import { buildRoundSteps, type RoundWork } from '../../src/cron/round-steps.js';

const nothing = async () => 0;
/** #356 AC-4 O RoundWork de dublê: os passos de hoje existem, com os custos declarados de verdade, e não fazem nada. */
const work: RoundWork = {
  capture: async () => ({ seen: 0, inserted: 0, checked: 0, failed: 0 }),
  markCheckFailures: async () => {},
  reportUnreconciledReceipts: async () => {},
  propose: async () => ({ proposed: 0, approvedByRule: 0 }),
  publishRegistry: nothing,
  publishDock: nothing,
  publishStore: nothing,
  publishReturns: nothing,
  blockDuplicates: async () => ({ blocked: 0, failed: 0 }),
  markOverdueSupplierRequests: nothing,
  claudeTasks: ['description-match', 'probable-order'],
  claudeTask: async () => {},
  engine: async () => ({ evaluated: 0, approved: 0 }),
  captureDemoNotes: async () => 0,
  failedSteps: () => [],
};

/** #356 AC-4 Um passo novo, como o #349 ou o #351 o escreveriam: nome, custo declarado e a execução. Nada mais. */
const newStep = (name: string, maxSubrequests: number, run: () => Promise<void> = async () => {}): RoundStep => ({ name, maxSubrequests, run });

/** #356 AC-4 Os passos de hoje com a fila CHEIA: cada um, ao rodar, gasta o que declarou, num contador que faz as vezes do medidor. */
function fullQueue(extra: readonly RoundStep[]) {
  let spent = 0;
  const ran: string[] = [];
  const spend = (s: RoundStep): RoundStep => ({ ...s, run: async () => { await s.run(); spent += s.maxSubrequests; ran.push(s.name); } });
  const steps = [...buildRoundSteps(work).steps, ...extra].map(spend);
  return { steps, spent: () => spent, ran };
}

describe('#356/AC-4 o passo acrescentado ao fim da lista segue as mesmas regras de planejamento', () => { // ADR-002
  it('é planejado pelo custo declarado: entra no plano ou fica adiado, e nunca some', () => { // ADR-002
    const steps = [...buildRoundSteps(work).steps, newStep('notas-novas', 12)];
    const plan = planRound(steps, []);
    expect([...plan.run.map((s) => s.name), ...plan.deferred]).toContain('notas-novas');
    expect(plan.run.reduce((n, s) => n + s.maxSubrequests, 0)).toBeLessThanOrEqual(STEP_BUDGET);
  });

  it('o custo declarado acima do orçamento faz o planRound lançar o erro de sempre, e quem declarou vê na hora', () => { // ADR-002
    const steps = [...buildRoundSteps(work).steps, newStep('notas-novas', STEP_BUDGET + 1)];
    expect(() => planRound(steps, [])).toThrow(/notas-novas.*orçamento/);
  });

  it('um passo novo que não cabe junto da captura é recusado pelo mesmo planRound, antes de a rodada rodar', () => { // ADR-002
    const capture = buildRoundSteps(work).steps.find((s) => s.critical);
    const steps = [...buildRoundSteps(work).steps, newStep('notas-novas', STEP_BUDGET - (capture?.maxSubrequests ?? 0) + 1)];
    expect(() => planRound(steps, [])).toThrow(/não cabe junto dos críticos/);
  });
});

describe('#356/AC-4 o passo acrescentado é admitido pelo gasto medido, com o executor de hoje', () => { // ADR-002
  it('com a fila cheia, o passo novo no fim é adiado na primeira rodada, roda numa seguinte e nenhum passo de hoje perde a vez', async () => { // ADR-002
    const w = fullQueue([newStep('notas-novas', 20)]);
    let deferred: readonly string[] = [];
    const rounds: string[][] = [];
    for (let i = 0; i < 14; i += 1) {
      const before = w.ran.length;
      const out = await executeRound(w.steps, deferred, w.spent);
      deferred = out.deferred;
      rounds.push(w.ran.slice(before));
      expect(out.failed).toEqual([]);
    }
    expect(rounds[0], 'a rodada cheia adia o do fim').not.toContain('notas-novas');
    expect(rounds.some((r) => r.includes('notas-novas')), 'sem fome: o passo novo roda').toBe(true);
    for (const s of w.steps) expect(rounds.some((r) => r.includes(s.name)), `${s.name} nunca rodou`).toBe(true);
  });

  it('com a fila vazia (gasto medido zero), o passo novo roda na primeira rodada, junto dos de hoje', async () => { // ADR-002
    const steps = [...buildRoundSteps(work).steps, newStep('notas-novas', 10)];
    const out = await executeRound(steps, [], () => 0);
    expect(out.ran).toContain('notas-novas');
    expect(out.deferred).not.toContain('notas-novas');
  });

  it('o passo novo que lança é isolado e contado como falha, e o resto da rodada segue', async () => { // ADR-002
    const steps = [newStep('notas-novas', 5, async () => { throw new TypeError('segredo-que-nao-vai-ao-log'); }), ...buildRoundSteps(work).steps];
    const out = await executeRound(steps, [], () => 0);
    expect(out.failed).toEqual([{ name: 'notas-novas', error: 'TypeError' }]);
    expect(out.ran).toContain('captura');
  });

  it('o passo novo que gasta mais que o declarado vai a overspent para o custo ser corrigido', async () => { // ADR-002
    let spent = 0;
    const steps = [newStep('notas-novas', 5, async () => { spent += 9; })];
    const out = await executeRound(steps, [], () => spent);
    expect(out.overspent).toEqual([{ name: 'notas-novas', declared: 5, measured: 9 }]);
  });
});

describe('#356/AC-4 o medidor corta o passo acrescentado antes da gravação e da soltura', () => { // ADR-002
  it('um passo novo que faz fetch sem fim é cortado em SUBREQUEST_CAP menos a reserva, e a gravação, o reenvio e a soltura ainda cabem', async () => { // ADR-002
    const meter = startRoundMeter({}, { now: () => 0, fetch: async () => new Response('{}') });
    const greedy = newStep('notas-novas', 5, async () => {
      for (let i = 0; i < SUBREQUEST_CAP * 2; i += 1) await meter.fetch('https://novo.test');
    });
    const out = await executeRound([greedy], [], meter.spent, meter.refused);
    expect(out.failed).toEqual([{ name: 'notas-novas', error: 'SubrequestBudgetError' }]);
    expect(meter.spent()).toBe(SUBREQUEST_CAP - FINISH_RESERVE);
    for (const alvo of ['record', 'reenvio', 'release']) await meter.reservedFetch(`https://${alvo}.test`);
    expect(meter.spent()).toBe(SUBREQUEST_CAP);
  });

  it('um passo novo que engole a recusa do medidor também falha, e o seguinte roda', async () => { // ADR-002
    const meter = startRoundMeter({}, { now: () => 0, fetch: async () => new Response('{}') });
    const swallowing = newStep('notas-novas', 5, async () => {
      for (let i = 0; i < SUBREQUEST_CAP * 2; i += 1) await meter.fetch('https://novo.test').catch(() => undefined);
    });
    const after = newStep('depois', 1);
    const out = await executeRound([swallowing, after], [], meter.spent, meter.refused);
    expect(out.failed.map((f) => f.name)).toEqual(['notas-novas']);
    expect(out.ran).toEqual(['depois']);
  });
});
