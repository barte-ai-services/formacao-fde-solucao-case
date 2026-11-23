/*
 * #356 AC-4 O orçamento da rodada: a rodada é uma lista ordenada de passos, cada um com o custo máximo
 * declarado em subrequests, e o executor roda os passos contra o teto de uma invocação do Worker.
 *
 * PONTO DE EXTENSÃO (#349, #351): para acrescentar um passo à rodada, acrescente um `RoundStep` à
 * lista que o tick monta, na posição em que ele deve rodar, e declare em `maxSubrequests` o MAIOR
 * número de fetch que ele faz numa rodada com a fila cheia (meça como `test/claude/budget.test.ts`:
 * fetch falso contando requisições). Um custo declarado a menos deixa o Worker estourar o teto; a mais,
 * adia o passo, e se ele não couber junto dos críticos (STEP_BUDGET menos a soma dos críticos) o planRound
 * lança erro e a rodada inteira não roda. O mesmo vale para críticos que somados passam do orçamento.
 * Marque `critical` só o que não pode esperar (a captura). Nenhum outro código precisa mudar: o executor
 * isola a falha do passo. Um passo com laço (um update ou uma publicação por item) leva um teto por chamada,
 * parâmetro do trabalho em cron/round-work.ts, e o custo declarado é medido NESSE teto, não no volume do kit.
 *
 * A ADMISSÃO: o conjunto garantido (`planRound`) é decidido só pelos custos declarados e nunca passa fome. Com o medidor
 * (`SpentMeter`, a porta `spent` de round.ts) o passo fora dele também roda quando o gasto medido deixa lugar, para a
 * rodada com a fila vazia não esticar a cadência de quem cabe. O piso de uma rodada ociosa é ler cada fila uma vez
 * (~40 subrequests medidos), então os passos de custo declarado alto, no fim da lista, ainda esperam algumas rodadas.
 */

import { SUBREQUEST_CAP } from '../cron/subrequests.js';

/**
 * #356 AC-4 A reserva fora do orçamento dos passos: o que a rodada gasta fora deles são 5 chamadas às portas (ler o modo,
 * tomar a trava, ler os adiados, gravar a rodada e soltar a trava), mais 2 de folga para um fetch que o gasto declarado
 * não previu e para o reenvio da gravação sem as colunas novas (#311). O medidor (cron/round-meter.ts, sobre o contador de
 * cron/subrequests.ts, o teto SUBREQUEST_CAP da #311) faz valer a conta: na fase dos passos recusa o fetch quando a contagem chega a
 * SUBREQUEST_CAP - FINISH_RESERVE (a gravação, o reenvio e a soltura que faltam), de modo que o excesso falha o passo e não a contabilidade.
 */
export const ROUND_RESERVE = 7;
/**
 * #356 AC-3 O limite real de duração da rodada: o medidor (cron/round-meter.ts) recusa todo fetch novo depois de 3 minutos
 * do começo da rodada, e a rodada acaba no máximo quando o fetch que já estava em curso termina. É a base da conta de
 * LOCK_TTL_MS (round.ts). A rodada do Claude para de começar tarefa antes, aos 2 minutos (ROUND_BUDGET_MS).
 */
export const ROUND_LIMIT_MS = 3 * 60_000;
/** #356 AC-4 O que sobra para os passos. */
export const STEP_BUDGET = SUBREQUEST_CAP - ROUND_RESERVE;

/**
 * #356 AC-4 Um passo da rodada: a unidade de extensão (#349, #351). A lista de `RoundStep` é montada em cron/round-steps.ts
 * (`buildRoundSteps`); um passo novo é só mais um item dela, com nome, custo declarado e execução, e é planejado
 * (`planRound`, pelo declarado), admitido (`executeRound`, pelo medido) e cortado (o medidor) como os demais. Veja
 * test/cron/round-extension.test.ts.
 */
export type RoundStep = {
  readonly name: string;
  /** #356 AC-4 O custo máximo, em subrequests, que o passo faz numa rodada com a fila cheia. */
  readonly maxSubrequests: number;
  /** #356 AC-4 O caminho crítico (a captura): nunca perde a vez para um passo adiado. */
  readonly critical?: boolean;
  readonly run: () => Promise<void>;
};

export type RoundPlan = { readonly run: RoundStep[]; readonly deferred: string[] };
export type RoundFailure = { readonly name: string; readonly error: string };
export type RoundOutcome = {
  readonly ran: string[];
  readonly failed: RoundFailure[];
  readonly deferred: string[];
  readonly overspent: RoundOverspend[];
};

/**
 * #356 AC-4 Quem pede a vez primeiro: o crítico, depois os adiados da rodada anterior (do que espera há mais
 * tempo ao que acabou de ser adiado), depois os demais na ordem da lista.
 */
function admissionOrder(steps: readonly RoundStep[], deferredBefore: readonly string[]): RoundStep[] {
  const waiting = (s: RoundStep): number => deferredBefore.indexOf(s.name);
  const rank = (s: RoundStep): number => (s.critical ? 0 : waiting(s) >= 0 ? 1 : 2);
  // #356 AC-4 sort é estável: fora dos adiados vale a ordem da lista.
  return [...steps].sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? waiting(a) - waiting(b) : 0));
}

/**
 * #356 AC-4 Decide quais passos cabem no orçamento. A prioridade só decide quem entra; os que entram rodam na
 * ordem da lista, a de hoje. Sem fome: o crítico mais o maior periférico sempre cabem (senão é erro de quem
 * declarou), o adiado passa à frente dos não adiados, e o que ficou de novo
 * de fora entra no fim da fila dos adiados, atrás dos que já esperavam. `deferred` sai nessa ordem
 * de espera e volta na rodada seguinte como `deferredBefore`.
 */
export function planRound(steps: readonly RoundStep[], deferredBefore: readonly string[]): RoundPlan {
  const tooBig = steps.find((s) => s.maxSubrequests > STEP_BUDGET);
  if (tooBig) throw new Error(`passo ${tooBig.name} declara ${tooBig.maxSubrequests} subrequests, mais que o orçamento ${STEP_BUDGET}`);
  const criticalCost = steps.filter((s) => s.critical).reduce((n, s) => n + s.maxSubrequests, 0);
  // #356 AC-4 a captura nunca perde a vez: os críticos juntos têm de caber, senão é erro de quem declarou.
  if (criticalCost > STEP_BUDGET) throw new Error(`os passos críticos declaram ${criticalCost} subrequests juntos, mais que o orçamento ${STEP_BUDGET}`);
  const starved = steps.find((s) => !s.critical && criticalCost + s.maxSubrequests > STEP_BUDGET);
  if (starved) throw new Error(`passo ${starved.name} não cabe junto dos críticos (${criticalCost}) no orçamento ${STEP_BUDGET}`);
  let left = STEP_BUDGET;
  const admitted = new Set<RoundStep>();
  for (const s of admissionOrder(steps, deferredBefore)) {
    if (s.maxSubrequests > left) continue;
    left -= s.maxSubrequests;
    admitted.add(s);
  }
  const out = steps.filter((s) => !admitted.has(s)).map((s) => s.name);
  const carried = deferredBefore.filter((n) => out.includes(n));
  return {
    run: steps.filter((s) => admitted.has(s)),
    deferred: [...carried, ...out.filter((n) => !carried.includes(n))],
  };
}

/** #356 AC-4 O passo que gastou mais subrequests que o custo declarado: vai ao log da rodada para o custo ser corrigido. */
export type RoundOverspend = { readonly name: string; readonly declared: number; readonly measured: number };

/**
 * #356 AC-4 O gasto medido da invocação até agora, em subrequests (uma porta: o medidor real, fora do domínio, conta
 * fetch a fetch tudo o que sai do Worker). O executor só subtrai dois valores dele, então a base não importa.
 */
export type SpentMeter = () => number;

/**
 * #356 AC-4 Um passo fora do conjunto garantido roda se o seu custo declarado couber no que sobra do orçamento depois
 * do gasto já feito (o medido) e do que os garantidos que faltam declaram.
 */
function fitsLeftover(step: RoundStep, usedSoFar: number, guaranteedLeft: number): boolean {
  return step.maxSubrequests <= STEP_BUDGET - usedSoFar - guaranteedLeft;
}

/**
 * #356 AC-4 Quantas chamadas, ou passos inteiros, o medidor recusou até agora (uma porta, como `SpentMeter`). O passo que engole a
 * recusa por dentro (guarda o erro e segue) também falhou, como na #311: o executor o conta em `failed` com a classe do erro de recusa.
 */
export type RefusedMeter = () => number;

/** #356 AC-4 A classe do erro que o passo que engoliu uma chamada recusada leva a `failed` (a de cron/subrequests.ts). */
export const REFUSED_ERROR = 'SubrequestBudgetError';

/**
 * #356 AC-4 Roda os passos, cada um falhando sozinho: a falha de um só é contada e o seguinte roda.
 * Os garantidos (os de `planRound`) sempre rodam, na ordem da lista. Com o medidor, o passo fora do garantido também
 * roda quando o gasto MEDIDO deixa lugar para ele sem tirar o dos garantidos que faltam: a fila vazia gasta pouco e
 * todo passo roda em toda rodada; a cheia gasta o declarado e o que não coube fica adiado para a rodada seguinte.
 * Sem o medidor, só os garantidos rodam. O gasto de um passo acima do declarado vai a `overspent` e sai do que sobra.
 */
export async function executeRound(
  steps: readonly RoundStep[],
  deferredBefore: readonly string[],
  spent?: SpentMeter,
  refused?: RefusedMeter,
): Promise<RoundOutcome> {
  const plan = planRound(steps, deferredBefore);
  const guaranteed = new Set<RoundStep>(plan.run);
  const ran: string[] = [];
  const failed: RoundFailure[] = [];
  const overspent: RoundOverspend[] = [];
  const notRun = new Set(plan.deferred);
  const start = spent?.() ?? 0;
  let guaranteedLeft = plan.run.reduce((n, s) => n + s.maxSubrequests, 0);
  for (const s of steps) {
    const isGuaranteed = guaranteed.has(s);
    if (isGuaranteed) guaranteedLeft -= s.maxSubrequests;
    else if (!spent || !fitsLeftover(s, spent() - start, guaranteedLeft)) continue;
    notRun.delete(s.name);
    const before = spent?.() ?? 0;
    const refusedBefore = refused?.() ?? 0;
    try {
      await s.run();
      if ((refused?.() ?? 0) > refusedBefore) failed.push({ name: s.name, error: REFUSED_ERROR });
      else ran.push(s.name);
    } catch (e) {
      // #356 AC-4 só a classe do erro vai ao resultado, nunca a mensagem, para o tick logar (#335)
      failed.push({ name: s.name, error: e instanceof Error ? e.name : typeof e });
    }
    const measured = spent ? spent() - before : 0;
    if (measured > s.maxSubrequests) overspent.push({ name: s.name, declared: s.maxSubrequests, measured });
  }
  return { ran, failed, deferred: plan.deferred.filter((n) => notRun.has(n)), overspent };
}
