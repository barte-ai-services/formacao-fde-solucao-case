// #371 AC-4 Com o modo demonstração desligado nada muda: a lista de passos, a ordem, os custos declarados, o planejamento e a execução
// #371 AC-4 da rodada de 15 minutos são os de antes do caminho fixo. Os valores abaixo são literais, capturados de origin/main (ede62ab) antes da mudança.
import { describe, expect, it } from 'vitest';
import { executeRound, planRound } from '../../src/automation/round-budget.js';
import { buildRoundSteps, type RoundWork } from '../../src/cron/round-steps.js';

const nothing = async () => 0;
/** #371 O RoundWork de dublê com as quatro tarefas do Claude de verdade (tasksFor): os passos existem e não fazem nada. */
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
  demoDockCount: async () => {},
  demoSupplierReplies: async () => {},
  claudeTasks: ['description-match', 'supplier-reply-reading', 'probable-order', 'supplier-request-draft'],
  claudeTask: async () => {},
  engine: async () => ({ evaluated: 0, approved: 0 }),
  captureDemoNotes: async () => 0,
  failedSteps: () => [],
};

/** #371 AC-4 Nome, custo declarado e se é crítico, na ordem da lista, como estava em origin/main. */
const BEFORE_STEPS: readonly (readonly [string, number, boolean])[] = [
  ['captura', 16, true],
  ['marcas-da-conferencia', 5, false],
  ['recebimentos-sem-nota', 3, false],
  ['propostas', 15, false],
  ['cadastro-e8-dias-0-1', 15, false],
  ['cadastro-e8-dias-2-3', 15, false],
  ['cadastro-e8-dias-4-5', 15, false],
  ['cadastro-e8-dias-6-6', 15, false],
  ['doca', 8, false],
  ['loja', 8, false],
  ['devolucoes', 10, false],
  ['duplicados', 11, false],
  ['prazo-fornecedor', 6, false],
  ['claude-description-match', 6, false],
  ['claude-supplier-reply-reading', 12, false],
  ['claude-probable-order', 12, false],
  ['claude-supplier-request-draft', 14, false],
  ['motor', 20, false],
];

describe('#371/AC-4 com o modo desligado a rodada de 15 minutos é idêntica à de antes', () => { // ADR-002
  const steps = buildRoundSteps(work).steps;

  it('a lista tem os mesmos passos, na mesma ordem, com os mesmos custos declarados, e nenhum é fixo', () => { // ADR-002
    expect(steps.map((s) => [s.name, s.maxSubrequests, s.critical === true])).toEqual(BEFORE_STEPS);
    expect(steps.some((s) => 'fixed' in s && s.fixed === true)).toBe(false);
  });

  it('o planejamento da primeira rodada garante a captura, as marcas, os recebimentos e as propostas, e adia o resto, o motor por último', () => { // ADR-002
    const plan = planRound(steps, []);
    expect(plan.run.map((s) => s.name)).toEqual(['captura', 'marcas-da-conferencia', 'recebimentos-sem-nota', 'propostas']);
    expect(plan.deferred).toEqual([
      'cadastro-e8-dias-0-1', 'cadastro-e8-dias-2-3', 'cadastro-e8-dias-4-5', 'cadastro-e8-dias-6-6', 'doca', 'loja', 'devolucoes', 'duplicados',
      'prazo-fornecedor', 'claude-description-match', 'claude-supplier-reply-reading', 'claude-probable-order', 'claude-supplier-request-draft', 'motor',
    ]);
  });

  it('o planejamento com adiados da rodada anterior põe o adiado mais antigo à frente, como antes', () => { // ADR-002
    const plan = planRound(steps, ['motor', 'cadastro-e8-dias-0-1', 'duplicados']);
    expect(plan.run.map((s) => s.name)).toEqual(['captura', 'marcas-da-conferencia', 'motor']);
    expect(plan.deferred).toEqual([
      'cadastro-e8-dias-0-1', 'duplicados', 'recebimentos-sem-nota', 'propostas', 'cadastro-e8-dias-2-3', 'cadastro-e8-dias-4-5', 'cadastro-e8-dias-6-6',
      'doca', 'loja', 'devolucoes', 'prazo-fornecedor', 'claude-description-match', 'claude-supplier-reply-reading', 'claude-probable-order',
      'claude-supplier-request-draft',
    ]);
  });

  it('a execução sem medidor roda só o garantido, na ordem da lista, e o resultado é o de antes', async () => { // ADR-002
    expect(await executeRound(steps, [])).toEqual({
      ran: ['captura', 'marcas-da-conferencia', 'recebimentos-sem-nota', 'propostas'],
      failed: [],
      deferred: [
        'cadastro-e8-dias-0-1', 'cadastro-e8-dias-2-3', 'cadastro-e8-dias-4-5', 'cadastro-e8-dias-6-6', 'doca', 'loja', 'devolucoes', 'duplicados',
        'prazo-fornecedor', 'claude-description-match', 'claude-supplier-reply-reading', 'claude-probable-order', 'claude-supplier-request-draft', 'motor',
      ],
      overspent: [],
    });
  });

  it('a execução com medidor (cada passo gasta metade do declarado) admite pelo gasto medido, e o resultado é o de antes', async () => { // ADR-002
    let used = 0;
    const costly = steps.map((s) => ({ ...s, run: async () => { used += Math.ceil(s.maxSubrequests / 2); } }));
    expect(await executeRound(costly, ['motor', 'duplicados'], () => used)).toEqual({
      ran: ['captura', 'marcas-da-conferencia', 'recebimentos-sem-nota', 'doca', 'prazo-fornecedor', 'motor'],
      failed: [],
      deferred: [
        'duplicados', 'propostas', 'cadastro-e8-dias-0-1', 'cadastro-e8-dias-2-3', 'cadastro-e8-dias-4-5', 'cadastro-e8-dias-6-6', 'loja', 'devolucoes',
        'claude-description-match', 'claude-supplier-reply-reading', 'claude-probable-order', 'claude-supplier-request-draft',
      ],
      overspent: [],
    });
  });
});
