import { describe, expect, it } from 'vitest';
import { planRound } from '../../src/automation/round-budget.js';
import { buildRoundSteps, STEP_COSTS, type RoundWork } from '../../src/cron/round-steps.js';
import { DEMO_NOTES_STEP_COST, DEMO_NOTES_STEP_NAME } from '../../src/demo/round-step.js';

function work(captured: number[]): RoundWork {
  const nothing = async () => 0;
  return {
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
    claudeTasks: ['description-match', 'supplier-reply-reading', 'probable-order', 'supplier-request-draft'],
    claudeTask: async () => {},
    engine: async () => ({ evaluated: 0, approved: 0 }),
    captureDemoNotes: async () => {
      captured.push(5);
      return 5;
    },
    demoDockCount: async () => {},
    demoSupplierReplies: async () => {},
    failedSteps: () => [],
  };
}

describe('#349 o passo das notas novas na lista da rodada', () => {
  it('com o modo desligado a lista é a de sempre: o passo não existe', () => {
    const names = buildRoundSteps(work([]), Date.now, undefined, false).steps.map((s) => s.name);
    expect(names).not.toContain(DEMO_NOTES_STEP_NAME);
  });

  it('com o modo ligado o passo vem antes da captura, com o custo declarado medido', async () => {
    const captured: number[] = [];
    const { steps } = buildRoundSteps(work(captured), Date.now, undefined, true);
    expect(steps.map((s) => s.name).slice(0, 2)).toEqual([DEMO_NOTES_STEP_NAME, 'captura']);
    expect(steps[0]?.maxSubrequests).toBe(STEP_COSTS.demoNotes);
    expect(STEP_COSTS.demoNotes).toBe(DEMO_NOTES_STEP_COST);
    await steps[0]?.run();
    expect(captured).toEqual([5]);
  });

  it('o passo cabe no orçamento: o plano com ele não lança e a captura segue garantida', () => {
    const { steps } = buildRoundSteps(work([]), Date.now, undefined, true);
    const plan = planRound(steps, []);
    expect(plan.run.map((s) => s.name)).toEqual(expect.arrayContaining([DEMO_NOTES_STEP_NAME, 'captura']));
  });
});
