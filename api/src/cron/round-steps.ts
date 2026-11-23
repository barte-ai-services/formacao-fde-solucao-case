/*
 * #356 AC-4 A lista de passos da rodada, na ordem de hoje (a de tick.ts antes do orçamento), cada um com o custo
 * máximo em subrequests MEDIDO por test/cron/round-steps-budget.test.ts (fetch falso contando requisições, com a
 * fila cheia de cada passo, o método de test/claude/budget.test.ts).
 *
 * PONTO DE EXTENSÃO (#349, #351): um passo novo entra aqui, em `buildRoundSteps`, na posição em que deve rodar, com
 * o trabalho em `RoundWork` e o custo medido em `STEP_COSTS`; o teste de medida cobra o custo declarado igual ao
 * medido, e o executor (automation/round-budget.ts) adia o que não couber e o roda na rodada seguinte.
 * Nada mais muda: a trava, o ritmo e a gravação são de automation/round.ts.
 */
import type { RoundStep } from '../automation/round-budget.js';
import type { RoundBuild } from '../automation/round.js';
import { NO_FIGURES, type RunFigures } from '../automation/runs.js';
import { ROUND_BUDGET_MS } from '../claude/cron.js';
import { DEMO_NOTES_STEP_COST, DEMO_NOTES_STEP_NAME } from '../demo/round-step.js';

/** #356 AC-4 O que cada passo faz no mundo, injetado: o adaptador real é cron/round-work.ts, os testes usam dublês. */
export interface RoundWork {
  /** #59 #66 As sugestões do Claude, a captura das notas e os recebimentos sem nota. */
  capture(): Promise<{ seen: number; inserted: number; checked: number; failed: number }>;
  /** #356 AC-4 As notas que quebraram na conferência desta rodada (a lista que `capture` guardou), marcadas até o teto por passo: um update por nota. */
  markCheckFailures(): Promise<void>;
  /** #59 Os recebimentos sem nota: só um diagnóstico no log, fora do caminho crítico para não pesar no orçamento da captura. */
  reportUnreconciledReceipts(): Promise<void>;
  /** #63 A proposta e a régua das notas conferidas. O dossiê das que esperam uma pessoa não é passo daqui: tem o cron próprio da #311 (cron/dossier-round.ts). */
  propose(): Promise<{ proposed: number; approvedByRule: number }>;
  /** #35 O E8 das decisões dos dias [from, to) da janela de 7 dias (0 é hoje, UTC): uma fatia por passo. */
  publishRegistry(from: number, to: number, limit?: number): Promise<number>;
  publishDock(): Promise<number>;
  publishStore(): Promise<number>;
  publishReturns(): Promise<number>;
  blockDuplicates(): Promise<{ blocked: number; failed: number }>;
  markOverdueSupplierRequests(): Promise<number>;
  /** #363 A contagem da doca da demonstração (notas origin='demo'): só entra na rodada com o modo ligado. */
  demoDockCount(): Promise<void>;
  /** #363 As respostas do fornecedor da demonstração (caixa de entrada mock): só entra na rodada com o modo ligado. */
  demoSupplierReplies(): Promise<void>;
  /** #171 Os nomes das tarefas do Claude da rodada (tasksFor); cada uma é um passo. */
  readonly claudeTasks: readonly string[];
  /** #356 AC-3 Uma tarefa do Claude até `deadline` (epoch em ms): o prazo é um por rodada, igual para todas. */
  claudeTask(name: string, deadline: number): Promise<void>;
  /** #311 Os passos periféricos que engoliram a própria falha durante a rodada (cada helper de tick.ts registra o seu nome fixo em `fail`). */
  failedSteps(): readonly string[];
  engine(): Promise<{ evaluated: number; approved: number }>;
  /** #349 As notas novas do modo demonstração: de 3 a 8 num lote só; devolve quantas entraram. Só o passo do modo ligado chama. */
  captureDemoNotes(): Promise<number>;
}

/**
 * #356 AC-4 O custo máximo declarado de cada passo, em subrequests, com a fila cheia: o número medido (ver o teste).
 * Passo a menos medido, o Worker estoura o teto; a mais, o passo é adiado sem precisar.
 * #362 Cada custo é o do passo SOZINHO, com a leitura guardada limpa (o teste a limpa antes de cada passo): a rodada lê cada consulta uma
 * vez (cron/tick.ts, `memoizeReads`), então o que um passo de antes leu não se paga de novo e a rodada gasta menos que a soma destes.
 * #362 O custo da captura cresce só com as notas guardadas e as emitidas: uma requisição a mais por 1000 notas guardadas (`listStored`)
 * e outra por 1000 emitidas (a leitura da SEFAZ), as duas paginadas de 1000 em 1000. A escala da turma fica bem abaixo disso.
 */
export const STEP_COSTS = {
  capture: 16,
  checkFailures: 5,
  unreconciled: 3,
  propose: 15,
  registry: 15,
  dock: 8,
  store: 8,
  returns: 10,
  duplicates: 11,
  supplierOverdue: 6,
  /** #363 Uma rpc de leitura e uma de gravação em lote (a medida do passo da demonstração). */
  dockCount: 2,
  supplierReplies: 2,
  engine: 20,
  demoNotes: DEMO_NOTES_STEP_COST,
  /**
   * #371 Os custos de `propostas` e `motor` no CAMINHO FIXO do modo demonstração: medidos em sequência, depois de notas-demo e captura, com a leitura
   * guardada da rodada valendo de um passo para o seguinte (test/cron/round-fixed-path-budget.test.ts), e não avulsos como os de cima. O motor, em
   * lote (ENGINE_LIMITS_DEMO: até 4 decisões por rodada, uma chamada ao Clef), grava as decisões numa requisição e relê as propostas numa vez só.
   */
  proposeFixed: 7,
  engineFixed: 15,
  /**
   * #371 O E8 de cada fatia no revezamento do modo demonstração: 7 leituras mais até REGISTRY_MESSAGES_PER_STEP_DEMO (3) publicações. Com o teto de 8 de
   * sempre (15) a fatia não cabia nunca ao lado do caminho fixo, que deixa no máximo 13 do orçamento; com 3, no máximo 10, e o que passar do teto fica
   * para a rodada seguinte (a caixa de saída é idempotente).
   */
  registryDemo: 10,
} as const satisfies Record<string, number>;

/** #356 AC-4 O custo medido de cada tarefa do Claude (a fila cheia dela), pelo nome em tasksFor. */
export const CLAUDE_TASK_COSTS: Readonly<Record<string, number>> = {
  'description-match': 6,
  'supplier-reply-reading': 12,
  'probable-order': 12,
  'supplier-request-draft': 14,
};

/** #356 AC-4 As fatias da janela do E8: cada uma cabe sozinha ao lado da captura. */
export const REGISTRY_SLICES: readonly (readonly [number, number])[] = [[0, 2], [2, 4], [4, 6], [6, 7]];
/** #371 O teto de mensagens E8 novas por fatia com o modo demonstração ligado (STEP_COSTS.registryDemo). */
export const REGISTRY_MESSAGES_PER_STEP_DEMO = 3;

/**
 * #356 AC-4 O passo que, se falha, grava a rodada como `failed`: só a captura, o caminho crítico (#311). Todo o resto falha sozinho,
 * entra em `failed_steps` e a rodada segue `ok`, como o tick de hoje.
 */
export const ROUND_FAILING_STEPS: ReadonlySet<string> = new Set(['captura']);

/**
 * #371 O caminho fixo da rodada com o modo demonstração ligado: roda em TODA rodada, antes dos demais, nesta ordem. A operação parece viva por causa
 * deles (as notas novas entram, são capturadas, ganham proposta e decisão do motor). Os demais passos se revezam com o que sobra do orçamento
 * (automation/round-budget.ts, `executeRound`).
 */
export const FIXED_PATH = ['notas-demo', 'captura', 'propostas', 'motor'] as const;

function claudeCost(task: string): number {
  const cost = CLAUDE_TASK_COSTS[task];
  if (cost === undefined) throw new Error(`a tarefa do Claude ${task} não tem custo medido em CLAUDE_TASK_COSTS`);
  return cost;
}

/**
 * #356 AC-4 Monta a rodada: a lista ordenada de passos e os números que ela acumula. A rodada só monta depois da trava
 * tomada; o prazo das tarefas do Claude (ROUND_BUDGET_MS) é fixado aqui, uma vez, e vale para todas (#356 AC-3: um
 * prazo por tarefa estouraria a validade da trava).
 */
export function buildRoundSteps(work: RoundWork, now: () => number = Date.now, claudeBudgetMs: number = ROUND_BUDGET_MS, demoEnabled = false): RoundBuild {
  const claudeDeadline = now() + claudeBudgetMs;
  const figures: { -readonly [K in keyof RunFigures]: RunFigures[K] } = { ...NO_FIGURES };
  const step = (name: string, maxSubrequests: number, run: () => Promise<void>, critical = false): RoundStep => ({
    name,
    maxSubrequests,
    ...(critical ? { critical } : {}),
    // #371 Com o modo ligado, os quatro passos do caminho fixo levam `fixed`; desligado, nenhum passo muda.
    ...(demoEnabled && (FIXED_PATH as readonly string[]).includes(name) ? { fixed: true } : {}),
    run,
  });
  /*
   * #356 AC-4 PONTO DE EXTENSÃO: A LISTA DE PASSOS. Quem acrescenta passo à rodada (#349, as notas novas; #351) acrescenta um
   * `step(nome, custo, execução)` AQUI, na posição em que deve rodar, e nada mais: o executor (automation/round-budget.ts) e o
   * medidor (cron/round-meter.ts) não mudam. O passo novo é submetido às mesmas três regras dos de hoje:
   *  1. o PLANEJAMENTO é pelo custo declarado (`planRound`): o conjunto garantido soma no máximo STEP_BUDGET (50 menos a reserva
   *     de 7), o passo que não cabe fica adiado e passa à frente na rodada seguinte (sem fome), e um custo declarado que não cabe
   *     junto da captura é erro de quem declarou;
   *  2. a ADMISSÃO é pelo gasto medido (`executeRound` com `spent`): o passo fora do garantido roda quando o gasto real deixa
   *     lugar para o declarado dele, então a fila vazia não adia ninguém;
   *  3. o CORTE é do medidor: o fetch que passa de SUBREQUEST_CAP menos FINISH_RESERVE falha o passo, nunca a gravação da rodada.
   * O custo declarado é o MAIOR gasto com a fila cheia, medido como em test/cron/round-steps-budget.test.ts. Os testes de
   * test/cron/round-extension.test.ts mostram um passo acrescentado ao fim planejado, admitido e cortado por essas regras.
   */
  const steps: RoundStep[] = [
    // #349 Com o modo demonstração ligado, as notas novas entram ANTES da captura, para a mesma rodada já capturá-las (e a faixa as contar).
    ...(demoEnabled ? [step(DEMO_NOTES_STEP_NAME, STEP_COSTS.demoNotes, async () => { await work.captureDemoNotes(); })] : []),
    step('captura', STEP_COSTS.capture, async () => {
      Object.assign(figures, await work.capture());
    }, true),
    step('marcas-da-conferencia', STEP_COSTS.checkFailures, () => work.markCheckFailures()),
    step('recebimentos-sem-nota', STEP_COSTS.unreconciled, () => work.reportUnreconciledReceipts()),
    step('propostas', demoEnabled ? STEP_COSTS.proposeFixed : STEP_COSTS.propose, async () => {
      const r = await work.propose();
      figures.proposed = r.proposed;
      figures.approvedByRule = r.approvedByRule;
    }),
    ...REGISTRY_SLICES.map(([from, to]) =>
      step(`cadastro-e8-dias-${from}-${to - 1}`, demoEnabled ? STEP_COSTS.registryDemo : STEP_COSTS.registry, async () => {
        figures.cadastroE8 += await (demoEnabled ? work.publishRegistry(from, to, REGISTRY_MESSAGES_PER_STEP_DEMO) : work.publishRegistry(from, to));
      }),
    ),
    step('doca', STEP_COSTS.dock, async () => {
      figures.dockPublished = await work.publishDock();
    }),
    step('loja', STEP_COSTS.store, async () => {
      figures.storePublished = await work.publishStore();
    }),
    // #363 A contagem da doca vem depois de 'doca' e 'loja', que publicam as ações que ela conta; só com o modo ligado.
    ...(demoEnabled ? [step('contagem-da-doca', STEP_COSTS.dockCount, () => work.demoDockCount())] : []),
    step('devolucoes', STEP_COSTS.returns, async () => {
      await work.publishReturns();
    }),
    step('duplicados', STEP_COSTS.duplicates, async () => {
      figures.duplicatesBlocked = (await work.blockDuplicates()).blocked;
    }),
    // #363 As respostas do fornecedor ficam ANTES de 'prazo-fornecedor': a resposta que chega nesta rodada já está na caixa quando a varredura
    // #363 procura pedido sem resposta, e não vira "sem resposta" à toa. Antes dos passos do Claude, que a leem. Só com o modo ligado.
    ...(demoEnabled ? [step('respostas-do-fornecedor', STEP_COSTS.supplierReplies, () => work.demoSupplierReplies())] : []),
    step('prazo-fornecedor', STEP_COSTS.supplierOverdue, async () => {
      await work.markOverdueSupplierRequests();
    }),
    ...work.claudeTasks.map((name) => step(`claude-${name}`, claudeCost(name), () => work.claudeTask(name, claudeDeadline))),
    step('motor', demoEnabled ? STEP_COSTS.engineFixed : STEP_COSTS.engine, async () => {
      const r = await work.engine();
      figures.engineEvaluated = r.evaluated;
      figures.engineApproved = r.approved;
    }),
  ];
  return { steps, figures: () => ({ ...figures }), failsRound: ROUND_FAILING_STEPS, failedSteps: () => work.failedSteps() };
}
