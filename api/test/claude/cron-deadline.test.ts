// #356 AC-3 A rodada do Claude aceita o prazo da rodada orquestrada, em vez de abrir um por chamada.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runClaudeRound } from '../../src/claude/cron.js';
import { ENV, fullWorld, messagesApi } from '../support/budget-world.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#356/AC-3 o prazo passado a runClaudeRound', () => { // ADR-002
  it('um prazo já vencido não começa nenhum pedido ao Claude', async () => { // ADR-002
    const { world: w } = await fullWorld();
    const api = messagesApi((key) => w.fake.rows('proposals').find((row) => row.invoice_access_key === key));
    await runClaudeRound(w.rest, ENV, { fetch: api.fetch, log: () => {}, only: ['description-match'], deadline: Date.now() - 1 });
    expect(api.calls()).toBe(0);
  });

  it('sem o prazo, a rodada abre o seu de ROUND_BUDGET_MS e trabalha', async () => { // ADR-002
    const { world: w } = await fullWorld();
    const api = messagesApi((key) => w.fake.rows('proposals').find((row) => row.invoice_access_key === key));
    await runClaudeRound(w.rest, ENV, { fetch: api.fetch, log: () => {}, only: ['description-match'] });
    expect(api.calls()).toBeGreaterThan(0);
  });
});
