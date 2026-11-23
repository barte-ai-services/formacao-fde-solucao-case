// #356 AC-4 O dublê do binding do Workers AI, com o único cast dos testes da rodada.

/** #356 AC-4 O binding com o `run` dado. */
export function fakeAi(run: (model: string, input: unknown) => Promise<unknown>): Ai {
  // #356 dublê do binding: só run é usado
  return { run } as unknown as Ai;
}
