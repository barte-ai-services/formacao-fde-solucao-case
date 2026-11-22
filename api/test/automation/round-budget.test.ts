// #356 AC-4 O orçamento da rodada: passos com custo declarado, adiados sem fome, falha isolada.
import { describe, expect, it } from 'vitest';
import {
  ROUND_RESERVE,
  STEP_BUDGET,
  SUBREQUEST_LIMIT,
  executeRound,
  planRound,
  type RoundStep,
} from '../../src/automation/round-budget.js';

const step = (name: string, maxSubrequests: number, extra: Partial<RoundStep> = {}): RoundStep => ({
  name,
  maxSubrequests,
  run: async () => {},
  ...extra,
});
const names = (steps: readonly RoundStep[]) => steps.map((s) => s.name);

describe('#356/AC-4 o teto por invocação', () => {
  it('o orçamento dos passos é o teto de 50 menos a reserva da rodada', () => {
    expect(SUBREQUEST_LIMIT).toBe(50);
    expect(ROUND_RESERVE).toBeGreaterThanOrEqual(4); // #356 AC-4 modo, tomar e soltar a trava, gravar a rodada
    expect(STEP_BUDGET).toBe(SUBREQUEST_LIMIT - ROUND_RESERVE);
  });
});

describe('#356/AC-4 planRound', () => {
  it('roda tudo, na ordem dada, quando cabe', () => {
    const plan = planRound([step('a', 10), step('b', 10), step('c', 10)], []);
    expect(names(plan.run)).toEqual(['a', 'b', 'c']);
    expect(plan.deferred).toEqual([]);
  });
  it('pula o passo que não cabe e roda o seguinte que cabe', () => {
    const plan = planRound([step('a', STEP_BUDGET - 5), step('b', 10), step('c', 5)], []);
    expect(names(plan.run)).toEqual(['a', 'c']);
    expect(plan.deferred).toEqual(['b']);
  });
  it('a soma dos custos declarados dos passos que rodam nunca passa do orçamento', () => {
    const steps = [step('a', 20), step('b', 20), step('c', 20), step('d', 3), step('e', 30)];
    const plan = planRound(steps, []);
    expect(plan.run.reduce((n, s) => n + s.maxSubrequests, 0)).toBeLessThanOrEqual(STEP_BUDGET);
  });
  it('um passo cujo custo sozinho passa do orçamento é erro de quem declarou', () => {
    expect(() => planRound([step('gigante', STEP_BUDGET + 1)], [])).toThrow(/gigante/);
  });
  it('sem fome: o adiado da rodada anterior ganha a vez, e a ordem de execução não muda', () => {
    const steps = [step('a', STEP_BUDGET - 5), step('b', 10), step('c', 5)];
    const first = planRound(steps, []);
    expect(first.deferred).toEqual(['b']);
    const second = planRound(steps, first.deferred);
    expect(names(second.run)).toEqual(['b', 'c']);
    expect(second.deferred).toEqual(['a']);
    const third = planRound(steps, second.deferred);
    expect(names(third.run)).toEqual(['a', 'c']);
  });
  it('o caminho crítico entra primeiro e o adiado passa à frente do que não esperou', () => {
    const steps = [step('a', 20), step('captura', 20, { critical: true }), step('b', 24)];
    const plan = planRound(steps, ['b']);
    expect(names(plan.run)).toEqual(['captura', 'b']);
    expect(plan.deferred).toEqual(['a']);
  });
  it('um periférico que não cabe junto dos críticos nunca rodaria: é erro de quem declarou', () => {
    const steps = [step('captura', STEP_BUDGET - 5, { critical: true }), step('b', 10)];
    expect(() => planRound(steps, [])).toThrow(/b/);
    expect(() => planRound([step('captura', 30, { critical: true }), step('b', STEP_BUDGET - 30)], [])).not.toThrow();
  });
  it('todo passo roda em alguma rodada: a lista toda é vista em poucas rodadas', () => {
    const steps = [
      step('captura', 20, { critical: true }),
      step('a', 15),
      step('b', 15),
      step('c', 15),
      step('d', 15),
    ];
    const seen = new Set<string>();
    let deferred: string[] = [];
    for (let round = 0; round < steps.length; round += 1) {
      const plan = planRound(steps, deferred);
      for (const s of plan.run) seen.add(s.name);
      deferred = plan.deferred;
    }
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'captura', 'd']);
  });
});

describe('#356/AC-4 executeRound', () => {
  it('executa os passos na ordem dada e devolve quem rodou e quem ficou', async () => {
    const order: string[] = [];
    const mk = (name: string, cost: number) => step(name, cost, { run: async () => void order.push(name) });
    const out = await executeRound([mk('a', STEP_BUDGET - 5), mk('b', 10), mk('c', 5)], []);
    expect(order).toEqual(['a', 'c']);
    expect(out).toEqual({ ran: ['a', 'c'], failed: [], deferred: ['b'] });
  });
  it('a falha de um passo não para os outros e só é contada', async () => {
    const order: string[] = [];
    const ok = (name: string) => step(name, 5, { run: async () => void order.push(name) });
    const broken = step('quebrado', 5, {
      run: async () => {
        throw new Error('segredo-que-não-vai-ao-resultado');
      },
    });
    const out = await executeRound([ok('a'), broken, ok('c')], []);
    expect(order).toEqual(['a', 'c']);
    expect(out.failed).toEqual([{ name: 'quebrado', error: 'Error' }]);
    expect(out.ran).toEqual(['a', 'c']);
    expect(JSON.stringify(out)).not.toContain('segredo');
  });
  it('a falha diz a classe do erro, nunca a mensagem, e um valor lançado que não é Error diz o tipo', async () => {
    const thrower = (name: string, value: unknown) =>
      step(name, 5, {
        run: async () => {
          throw value;
        },
      });
    const out = await executeRound([thrower('tipo', new TypeError('segredo')), thrower('texto', 'segredo')], []);
    expect(out.failed).toEqual([
      { name: 'tipo', error: 'TypeError' },
      { name: 'texto', error: 'string' },
    ]);
    expect(JSON.stringify(out)).not.toContain('segredo');
  });
  it('um passo adiado roda na rodada seguinte', async () => {
    const order: string[] = [];
    const mk = (name: string, cost: number) => step(name, cost, { run: async () => void order.push(name) });
    const steps = [mk('a', STEP_BUDGET - 5), mk('b', 10)];
    const first = await executeRound(steps, []);
    const second = await executeRound(steps, first.deferred);
    expect(order).toEqual(['a', 'b']);
    expect(second.ran).toEqual(['b']);
  });
});
