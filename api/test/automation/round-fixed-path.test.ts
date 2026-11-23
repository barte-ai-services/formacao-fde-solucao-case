// #371 O caminho fixo da rodada: o passo `fixed` roda em toda rodada, antes dos demais, sem admissão; os demais se revezam com o que sobra,
// #371 o adiado há mais tempo primeiro, e a rodada sem passo fixo continua a de antes (test/cron/round-demo-off-identical.test.ts).
import { describe, expect, it } from 'vitest';
import { executeRound, planRound, STEP_BUDGET, type RoundStep } from '../../src/automation/round-budget.js';

const mk = (name: string, maxSubrequests: number, extra: Partial<RoundStep> = {}, ran: string[] = []): RoundStep => ({
  name,
  maxSubrequests,
  ...extra,
  run: async () => void ran.push(name),
});

describe('#371 planRound com passos fixos', () => { // ADR-002
  it('os fixos entram sempre, mesmo somando quase o orçamento, e o que não cabe no declarado fica adiado', () => { // ADR-002
    const steps = [mk('a', 2, { fixed: true }), mk('b', 16, { fixed: true }), mk('c', 7, { fixed: true }), mk('d', 17, { fixed: true }), mk('e', 15), mk('f', 1)];
    const plan = planRound(steps, []);
    expect(plan.run.map((s) => s.name)).toEqual(['a', 'b', 'c', 'd', 'f']);
    expect(plan.deferred).toEqual(['e']);
  });

  it('um passo que se reveza maior que o que sobra do declarado NÃO faz o planRound lançar: a vez dele vem do gasto medido', () => { // ADR-002
    const steps = [mk('fixo', 42, { fixed: true }), mk('pesado', 15)];
    expect(() => planRound(steps, [])).not.toThrow();
  });

  it('os fixos que somam mais que o orçamento lançam o erro de quem declarou', () => { // ADR-002
    const steps = [mk('a', STEP_BUDGET - 1, { fixed: true }), mk('b', 2, { fixed: true })];
    expect(() => planRound(steps, [])).toThrow(/fixos e críticos declaram .* mais que o orçamento/);
  });

  it('entre os que se revezam, o adiado há mais tempo passa à frente', () => { // ADR-002
    const steps = [mk('fixo', 30, { fixed: true }), mk('x', 10), mk('y', 10), mk('z', 10)];
    const plan = planRound(steps, ['z', 'y']);
    expect(plan.run.map((s) => s.name)).toEqual(['fixo', 'z']);
    expect(plan.deferred).toEqual(['y', 'x']);
  });
});

describe('#371 executeRound com passos fixos', () => { // ADR-002
  it('os fixos rodam primeiro, na ordem da lista, ainda que venham depois na lista, e sempre, com a fila cheia', async () => { // ADR-002
    const ran: string[] = [];
    const steps = [mk('antes', 5, {}, ran), mk('fixo-1', 20, { fixed: true }, ran), mk('meio', 5, {}, ran), mk('fixo-2', 20, { fixed: true }, ran)];
    let used = 0;
    const spending = steps.map((s) => ({ ...s, run: async () => { await s.run(); used += s.maxSubrequests; } }));
    const out = await executeRound(spending, [], () => used);
    expect(ran.slice(0, 2)).toEqual(['fixo-1', 'fixo-2']);
    expect(out.ran.slice(0, 2)).toEqual(['fixo-1', 'fixo-2']);
    expect(out.failed).toEqual([]);
  });

  it('o passo fixo que lança é isolado e a rodada segue; ele não vira o adiado nem faz o executor lançar', async () => { // ADR-002
    const ran: string[] = [];
    const boom: RoundStep = { name: 'fixo', maxSubrequests: 3, fixed: true, run: async () => { throw new TypeError('segredo'); } };
    const out = await executeRound([boom, mk('outro', 3, {}, ran)], [], () => 0);
    expect(out.failed).toEqual([{ name: 'fixo', error: 'TypeError' }]);
    expect(ran).toEqual(['outro']);
    expect(out.deferred).toEqual([]);
  });

  it('com o medidor, o que sobra do orçamento medido é dividido pelo adiado mais antigo, e roda na ordem da lista', async () => { // ADR-002
    const ran: string[] = [];
    let used = 0;
    const cost = (s: RoundStep): RoundStep => ({ ...s, run: async () => { await s.run(); used += 5; } });
    const steps = [mk('fixo', 30, { fixed: true }, ran), mk('a', 10, {}, ran), mk('b', 10, {}, ran), mk('c', 10, {}, ran)].map(cost);
    // o fixo gastou 5 (não 30): sobram 38; cabem a, b e c (30) pelo declarado
    const first = await executeRound(steps, [], () => used);
    expect(first.ran).toEqual(['fixo', 'a', 'b', 'c']);
    // o fixo gasta 30 de verdade: sobram 13, cabe um, o mais antigo adiado
    used = 0;
    const heavy = [{ ...steps[0]!, run: async () => { used += 30; } }, ...steps.slice(1)];
    const second = await executeRound(heavy, ['c', 'b'], () => used);
    expect(second.ran).toEqual(['fixo', 'c']);
    expect(second.deferred).toEqual(['b', 'a']);
  });

  it('sem medidor só o garantido pelo declarado roda, e os fixos entram', async () => { // ADR-002
    const ran: string[] = [];
    const steps = [mk('fixo', 40, { fixed: true }, ran), mk('pequeno', 3, {}, ran), mk('grande', 20, {}, ran)];
    const out = await executeRound(steps, []);
    expect(out.ran).toEqual(['fixo', 'pequeno']);
    expect(out.deferred).toEqual(['grande']);
  });

  it('o gasto do passo abaixo do declarado deixa lugar: a segunda passada admite o que ainda cabe, na ordem de espera', async () => { // ADR-002
    const ran: string[] = [];
    let used = 0;
    const cost = (s: RoundStep, spend: number): RoundStep => ({ ...s, run: async () => { await s.run(); used += spend; } });
    const steps = [cost(mk('fixo', 20, { fixed: true }, ran), 20), cost(mk('a', 20, {}, ran), 1), cost(mk('b', 20, {}, ran), 8), cost(mk('c', 20, {}, ran), 8)];
    // sobram 23: o declarado empacota só a (20); a gasta 1 e a segunda passada admite b (20 cabe em 22); b gasta 8 e c (20) não cabe em 14
    const out = await executeRound(steps, [], () => used);
    expect(out.ran).toEqual(['fixo', 'a', 'b']);
    expect(out.deferred).toEqual(['c']);
  });

  it('o tempo da rodada acabando deixa o passo adiado, não falho', async () => { // ADR-002
    let over = false;
    const steps = [{ ...mk('fixo', 2, { fixed: true }), run: async () => { over = true; } }, mk('outro', 2)];
    const out = await executeRound(steps, [], () => 0, undefined, () => over);
    expect(out.ran).toEqual(['fixo']);
    expect(out.deferred).toEqual(['outro']);
    expect(out.failed).toEqual([]);
  });
});
