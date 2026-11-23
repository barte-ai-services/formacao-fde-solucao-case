// #356 A rodada orçada executa só o que cabe nos 50 subrequests e deixa o resto para a seguinte (o adiado passa à frente): o teste de um passo
// #356 que fica no fim da lista (o motor, o Claude) roda rodadas seguidas até o passo ter rodado, em vez de supor que uma rodada faz tudo.
import { expect } from 'vitest';

/** #356 Roda `round` até `done()` ser verdadeiro, no máximo `max` vezes; falha se o passo nunca teve a vez (o que seria fome de passo). */
export async function roundsUntil(round: () => Promise<unknown>, done: () => boolean, max = 12): Promise<number> {
  let count = 0;
  while (!done() && count < max) {
    await round();
    count += 1;
  }
  expect(done(), `o passo não rodou em ${max} rodadas`).toBe(true);
  return count;
}

/** #356 Roda `count` rodadas seguidas. */
export async function rounds(round: () => Promise<unknown>, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await round();
}
