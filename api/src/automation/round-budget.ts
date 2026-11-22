// #356 AC-4 O orçamento da rodada: a rodada é uma lista ordenada de passos, cada um com o custo máximo
// declarado em subrequests, e o executor roda os passos contra o teto de uma invocação do Worker.
//
// PONTO DE EXTENSÃO (#349, #351): para acrescentar um passo à rodada, acrescente um `RoundStep` à
// lista que o tick monta, na posição em que ele deve rodar, e declare em `maxSubrequests` o MAIOR
// número de fetch que ele faz numa rodada com a fila cheia (meça como `test/claude/budget.test.ts`:
// fetch falso contando requisições). Um custo declarado a menos deixa o Worker estourar o teto; a
// mais, só adia o passo à toa. Marque `critical` só o que não pode esperar (a captura). Nenhum outro
// código precisa mudar: o planejador adia o que não couber e o executor isola a falha do passo.

/** O teto de subrequests de uma invocação do Worker. */
export const SUBREQUEST_LIMIT = 50;
/**
 * O que a rodada gasta fora dos passos: ler o modo (1), tomar a trava (1), soltá-la (1) e gravar a
 * rodada (1), mais 2 de folga para a atualização da linha e para o log que vai a um serviço.
 */
export const ROUND_RESERVE = 6;
/** O que sobra para os passos. */
export const STEP_BUDGET = SUBREQUEST_LIMIT - ROUND_RESERVE;

export type RoundStep = {
  readonly name: string;
  /** O custo máximo, em subrequests, que o passo faz numa rodada com a fila cheia. */
  readonly maxSubrequests: number;
  /** O caminho crítico (a captura): nunca perde a vez para um passo adiado. */
  readonly critical?: boolean;
  readonly run: () => Promise<void>;
};

export type RoundPlan = { readonly run: RoundStep[]; readonly deferred: string[] };
export type RoundOutcome = { readonly ran: string[]; readonly failed: string[]; readonly deferred: string[] };

/**
 * Quem pede a vez primeiro: o crítico, depois os adiados da rodada anterior (do que espera há mais
 * tempo ao que acabou de ser adiado), depois os demais na ordem da lista.
 */
function admissionOrder(steps: readonly RoundStep[], deferredBefore: readonly string[]): RoundStep[] {
  const waiting = (s: RoundStep): number => deferredBefore.indexOf(s.name);
  const rank = (s: RoundStep): number => (s.critical ? 0 : waiting(s) >= 0 ? 1 : 2);
  // sort é estável: fora dos adiados vale a ordem da lista.
  return [...steps].sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? waiting(a) - waiting(b) : 0));
}

/**
 * Decide quais passos cabem no orçamento. A prioridade só decide quem entra; os que entram rodam na
 * ordem da lista, a de hoje. Sem fome: o adiado passa à frente dos não adiados, e o que ficou de novo
 * de fora entra no fim da fila dos adiados, atrás dos que já esperavam. `deferred` sai nessa ordem
 * de espera e volta na rodada seguinte como `deferredBefore`.
 */
export function planRound(steps: readonly RoundStep[], deferredBefore: readonly string[]): RoundPlan {
  const tooBig = steps.find((s) => s.maxSubrequests > STEP_BUDGET);
  if (tooBig) throw new Error(`passo ${tooBig.name} declara ${tooBig.maxSubrequests} subrequests, mais que o orçamento ${STEP_BUDGET}`);
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

/** Roda os passos que cabem, cada um falhando sozinho: a falha de um só é contada e o seguinte roda. */
export async function executeRound(steps: readonly RoundStep[], deferredBefore: readonly string[]): Promise<RoundOutcome> {
  const plan = planRound(steps, deferredBefore);
  const ran: string[] = [];
  const failed: string[] = [];
  for (const s of plan.run) {
    try {
      await s.run();
      ran.push(s.name);
    } catch {
      failed.push(s.name); // o erro não sobe nem vai ao resultado: quem quer o motivo loga dentro do passo
    }
  }
  return { ran, failed, deferred: plan.deferred };
}
