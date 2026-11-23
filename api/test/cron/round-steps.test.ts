// #356 AC-4 A montagem da lista de passos: o prazo único dos passos do Claude e a lista contra um RoundWork de dublê.
import { describe, expect, it } from 'vitest';
import { ROUND_BUDGET_MS } from '../../src/claude/cron.js';
import { buildRoundSteps, STEP_COSTS, type RoundWork } from '../../src/cron/round-steps.js';

/** #356 AC-4 Um RoundWork de dublê que só anota o prazo que cada tarefa do Claude recebeu. */
function work(deadlines: Map<string, number>): RoundWork {
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
    claudeTasks: ['description-match', 'probable-order'],
    claudeTask: async (name, deadline) => void deadlines.set(name, deadline),
    engine: async () => ({ evaluated: 0, approved: 0 }),
    failedSteps: () => ['dock'],
  };
}

describe('#356/AC-3 um prazo por rodada para os passos do Claude', () => { // ADR-002
  it('todas as tarefas do Claude recebem o mesmo prazo, fixado ao montar a rodada, mesmo com o relógio andando', async () => { // ADR-002
    const deadlines = new Map<string, number>();
    let now = 1_000_000;
    const build = buildRoundSteps(work(deadlines), () => now);
    const claude = build.steps.filter((s) => s.name.startsWith('claude-'));
    expect(claude).toHaveLength(2);
    for (const s of claude) {
      await s.run();
      now += 90_000; // #356 AC-3 cada tarefa leva um minuto e meio: com um prazo por passo a rodada passaria dos 5 minutos da trava
    }
    expect([...deadlines.values()]).toEqual([1_000_000 + ROUND_BUDGET_MS, 1_000_000 + ROUND_BUDGET_MS]);
  });

  it('cada rodada monta o seu prazo: a seguinte não herda o da anterior', async () => { // ADR-002
    const deadlines = new Map<string, number>();
    let now = 5_000;
    const first = buildRoundSteps(work(deadlines), () => now);
    now = 900_000;
    const second = buildRoundSteps(work(deadlines), () => now);
    await first.steps.find((s) => s.name === 'claude-probable-order')?.run();
    expect(deadlines.get('probable-order')).toBe(5_000 + ROUND_BUDGET_MS);
    await second.steps.find((s) => s.name === 'claude-probable-order')?.run();
    expect(deadlines.get('probable-order')).toBe(900_000 + ROUND_BUDGET_MS);
  });
});

describe('#311 a rodada orquestrada não despacha o dossiê e só a captura a faz falhar', () => { // ADR-002
  it('não há passo de dossiê na lista: o despacho é do cron próprio da #311', () => { // ADR-002
    const names = buildRoundSteps(work(new Map())).steps.map((s) => s.name);
    expect(names.filter((n) => n.includes('dossi'))).toEqual([]);
    expect(Object.keys(STEP_COSTS)).not.toContain('dossiers');
  });

  it('só a captura faz a rodada ser gravada como failed; os demais falham sozinhos', () => { // ADR-002
    expect([...buildRoundSteps(work(new Map())).failsRound]).toEqual(['captura']);
  });

  it('os passos que engoliram a própria falha chegam à rodada pelo trabalho', () => { // ADR-002
    expect(buildRoundSteps(work(new Map())).failedSteps()).toEqual(['dock']);
  });
});
