// #351 O modo que a rodada leu chega ao motor sem requisição a mais; sem leitura, o motor falha fechado.
import { describe, expect, it } from 'vitest';
import { supabaseRoundWork } from '../../src/cron/round-work.js';

describe('#351 fiação do modo demonstração no passo do motor', () => {
  it('supabaseRoundWork aceita demoMode e o passo do motor não quebra sem o binding de IA', async () => {
    const work = supabaseRoundWork({} as never, {} as never, undefined, { demoMode: async () => true });
    await expect(work.engine()).resolves.toEqual({ evaluated: 0, approved: 0 });
  });
});
