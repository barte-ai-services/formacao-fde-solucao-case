// #356 AC-4 O orçamento da rodada: passos com custo declarado, adiados sem fome, falha isolada.
import { describe, expect, it } from 'vitest';
import {
  ROUND_RESERVE,
  STEP_BUDGET,
  REFUSED_ERROR,
  executeRound,
  planRound,
  type RoundStep,
} from '../../src/automation/round-budget.js';
import { SUBREQUEST_CAP } from '../../src/cron/subrequests.js';

const step = (name: string, maxSubrequests: number, extra: Partial<RoundStep> = {}): RoundStep => ({
  name,
  maxSubrequests,
  run: async () => {},
  ...extra,
});
const names = (steps: readonly RoundStep[]) => steps.map((s) => s.name);

describe('#356/AC-4 o teto por invocação', () => { // ADR-002
  it('o orçamento dos passos é o teto de 50 menos a reserva da rodada', () => { // ADR-002
    expect(SUBREQUEST_CAP).toBe(50);
    expect(ROUND_RESERVE).toBe(7); // #356 AC-4 5 chamadas às portas (modo, trava, adiados, gravar, soltar) e 2 de folga
    expect(STEP_BUDGET).toBe(43);
    expect(STEP_BUDGET).toBe(SUBREQUEST_CAP - ROUND_RESERVE);
  });
});

describe('#356/AC-4 planRound', () => { // ADR-002
  it('roda tudo, na ordem dada, quando cabe', () => { // ADR-002
    const plan = planRound([step('a', 10), step('b', 10), step('c', 10)], []);
    expect(names(plan.run)).toEqual(['a', 'b', 'c']);
    expect(plan.deferred).toEqual([]);
  });
  it('pula o passo que não cabe e roda o seguinte que cabe', () => { // ADR-002
    const plan = planRound([step('a', STEP_BUDGET - 5), step('b', 10), step('c', 5)], []);
    expect(names(plan.run)).toEqual(['a', 'c']);
    expect(plan.deferred).toEqual(['b']);
  });
  it('a soma dos custos declarados dos passos que rodam nunca passa do orçamento', () => { // ADR-002
    const steps = [step('a', 20), step('b', 20), step('c', 20), step('d', 3), step('e', 30)];
    const plan = planRound(steps, []);
    expect(plan.run.reduce((n, s) => n + s.maxSubrequests, 0)).toBeLessThanOrEqual(STEP_BUDGET);
  });
  it('um passo cujo custo sozinho passa do orçamento é erro de quem declarou', () => { // ADR-002
    expect(() => planRound([step('gigante', STEP_BUDGET + 1)], [])).toThrow(/gigante/);
  });
  it('sem fome: o adiado da rodada anterior ganha a vez, e a ordem de execução não muda', () => { // ADR-002
    const steps = [step('a', STEP_BUDGET - 5), step('b', 10), step('c', 5)];
    const first = planRound(steps, []);
    expect(first.deferred).toEqual(['b']);
    const second = planRound(steps, first.deferred);
    expect(names(second.run)).toEqual(['b', 'c']);
    expect(second.deferred).toEqual(['a']);
    const third = planRound(steps, second.deferred);
    expect(names(third.run)).toEqual(['a', 'c']);
  });
  it('o caminho crítico entra primeiro e o adiado passa à frente do que não esperou', () => { // ADR-002
    const steps = [step('a', 20), step('captura', 20, { critical: true }), step('b', 23)];
    const plan = planRound(steps, ['b']);
    expect(names(plan.run)).toEqual(['captura', 'b']);
    expect(plan.deferred).toEqual(['a']);
  });
  it('um periférico que não cabe junto dos críticos nunca rodaria: é erro de quem declarou', () => { // ADR-002
    const steps = [step('captura', STEP_BUDGET - 5, { critical: true }), step('b', 10)];
    expect(() => planRound(steps, [])).toThrow(/b/);
    expect(() => planRound([step('captura', 30, { critical: true }), step('b', STEP_BUDGET - 30)], [])).not.toThrow();
  });
  it('os críticos cujo custo somado passa do orçamento são erro de quem declarou: a captura nunca perde a vez', () => { // ADR-002
    const steps = [step('captura', 30, { critical: true }), step('segundo', 30, { critical: true })]; // #356 AC-4 soma 60 > 44
    expect(() => planRound(steps, [])).toThrow(/cr[ií]ticos/);
    expect(() => planRound([step('captura', 30, { critical: true }), step('segundo', STEP_BUDGET - 30, { critical: true })], [])).not.toThrow();
  });
  it('todo passo roda em alguma rodada: a lista toda é vista em poucas rodadas', () => { // ADR-002
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

describe('#356/AC-4 executeRound', () => { // ADR-002
  it('executa os passos na ordem dada e devolve quem rodou e quem ficou', async () => { // ADR-002
    const order: string[] = [];
    const mk = (name: string, cost: number) => step(name, cost, { run: async () => void order.push(name) });
    const out = await executeRound([mk('a', STEP_BUDGET - 5), mk('b', 10), mk('c', 5)], []);
    expect(order).toEqual(['a', 'c']);
    expect(out).toEqual({ ran: ['a', 'c'], failed: [], deferred: ['b'], overspent: [] });
  });
  it('a falha de um passo não para os outros e só é contada', async () => { // ADR-002
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
  it('a falha diz a classe do erro, nunca a mensagem, e um valor lançado que não é Error diz o tipo', async () => { // ADR-002
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
  it('um passo adiado roda na rodada seguinte', async () => { // ADR-002
    const order: string[] = [];
    const mk = (name: string, cost: number) => step(name, cost, { run: async () => void order.push(name) });
    const steps = [mk('a', STEP_BUDGET - 5), mk('b', 10)];
    const first = await executeRound(steps, []);
    const second = await executeRound(steps, first.deferred);
    expect(order).toEqual(['a', 'b']);
    expect(second.ran).toEqual(['b']);
  });
});

/** #356 AC-4 Um medidor falso: cada passo gasta o que `spends` diz (o declarado, na fila cheia; pouco, na vazia). */
function meteredWorld(spends: Record<string, number>) {
  let spent = 1000; // #356 AC-4 o medidor pode já vir com o gasto da leitura do modo e da trava: conta-se a partir do início da rodada
  const ran: string[] = [];
  const mk = (name: string, cost: number, critical = false): RoundStep => ({
    name,
    maxSubrequests: cost,
    ...(critical ? { critical } : {}),
    run: async () => {
      ran.push(name);
      spent += spends[name] ?? cost;
    },
  });
  return { mk, ran, spent: () => spent };
}

describe('#311 o passo que engole a chamada recusada por falta de orçamento também falhou', () => { // ADR-002
  /** #356 AC-4 Um medidor falso de recusas: o passo `engole` recusa uma chamada e segue sem lançar. */
  function refusingWorld() {
    let refused = 3; // #311 o medidor pode já ter recusado antes do passo; só o aumento durante o passo é dele
    const swallowing: RoundStep = { name: 'doca', maxSubrequests: 8, run: async () => { refused += 1; } };
    const quiet: RoundStep = { name: 'loja', maxSubrequests: 8, run: async () => {} };
    return { swallowing, quiet, refused: () => refused };
  }

  it('o passo que não lançou mas teve uma chamada recusada vai a `failed` com a classe do erro de recusa, e o seguinte roda', async () => { // ADR-002
    const w = refusingWorld();
    const out = await executeRound([w.swallowing, w.quiet], [], () => 0, w.refused);
    expect(out.failed).toEqual([{ name: 'doca', error: REFUSED_ERROR }]);
    expect(out.ran).toEqual(['loja']);
    expect(REFUSED_ERROR).toBe('SubrequestBudgetError');
  });

  it('sem recusa durante o passo, ele roda sem falha, e sem o medidor de recusas a conta não existe', async () => { // ADR-002
    const w = refusingWorld();
    expect((await executeRound([w.quiet], [], () => 0, w.refused)).failed).toEqual([]);
    expect((await executeRound([w.swallowing], [], () => 0)).failed).toEqual([]);
  });
});

describe('#356/AC-4 a admissão pelo gasto medido', () => { // ADR-002
  it('com a fila vazia (gasto real baixo), o passo fora do conjunto garantido também roda na mesma rodada', async () => { // ADR-002
    const w = meteredWorld({ captura: 1, a: 1, b: 1 });
    const steps = [w.mk('captura', 18, true), w.mk('a', 25), w.mk('b', 25)];
    const out = await executeRound(steps, [], w.spent);
    expect(out.ran).toEqual(['captura', 'a', 'b']);
    expect(out.deferred).toEqual([]);
  });

  it('com a fila cheia (gasto real igual ao declarado), o que não coube fica adiado e roda na rodada seguinte', async () => { // ADR-002
    const w = meteredWorld({});
    const steps = [w.mk('captura', 18, true), w.mk('a', 25), w.mk('b', 25)];
    const first = await executeRound(steps, [], w.spent);
    expect(first.ran).toEqual(['captura', 'a']);
    expect(first.deferred).toEqual(['b']);
    const second = await executeRound(steps, first.deferred, w.spent);
    expect(second.ran).toEqual(['captura', 'b']);
  });

  it('conta o gasto a partir do começo da rodada, não do que o medidor já tinha', async () => { // ADR-002
    const w = meteredWorld({});
    const out = await executeRound([w.mk('a', 20), w.mk('b', 20)], [], w.spent);
    expect(out.ran).toEqual(['a', 'b']);
  });

  it('um passo fora do garantido não toma o lugar de um garantido que ainda não rodou', async () => { // ADR-002
    const w = meteredWorld({ o: 1, g: 30 });
    const steps = [w.mk('o', 20), w.mk('g', 30)]; // #356 AC-4 g espera desde a rodada anterior e entra no garantido; o não cabe junto dele
    const out = await executeRound(steps, ['g'], w.spent);
    expect(out.ran).toEqual(['g']);
    expect(out.deferred).toEqual(['o']);
  });

  it('o garantido roda mesmo quando o gasto medido já passou do que cabia (a regra sem fome não muda)', async () => { // ADR-002
    const w = meteredWorld({ a: 60 });
    const out = await executeRound([w.mk('a', 20), w.mk('captura', 20, true)], [], w.spent);
    expect(out.ran).toEqual(['a', 'captura']);
  });

  it('o passo que gasta mais que o declarado vai a `overspent` com o declarado e o medido, e o excesso sai do que sobra', async () => { // ADR-002
    const w = meteredWorld({ a: 40, b: 1 });
    const steps = [w.mk('a', 20), w.mk('b', 20), w.mk('c', 10)]; // #356 AC-4 o garantido é a e b; o c só roda se sobrar
    const out = await executeRound(steps, [], w.spent);
    expect(out.overspent).toEqual([{ name: 'a', declared: 20, measured: 40 }]);
    expect(out.ran).toEqual(['a', 'b']); // #356 AC-4 pelo declarado sobrariam 23 e o c rodaria; pelo medido sobram 3
    expect(out.deferred).toEqual(['c']);
  });

  it('o passo que falha também tem o gasto contado', async () => { // ADR-002
    let spent = 0;
    const broken: RoundStep = { name: 'quebrado', maxSubrequests: 5, run: async () => { spent += 40; throw new Error('segredo'); } };
    const out = await executeRound([broken, step('x', 30), step('b', 10)], [], () => spent);
    expect(out.failed).toEqual([{ name: 'quebrado', error: 'Error' }]);
    expect(out.overspent).toEqual([{ name: 'quebrado', declared: 5, measured: 40 }]);
    expect(out.deferred).toEqual(['b']);
  });

  it('o erro de custo mal declarado continua o do planRound, com ou sem medidor', async () => { // ADR-002
    await expect(executeRound([step('gigante', STEP_BUDGET + 1)], [], () => 0)).rejects.toThrow(/gigante/);
  });

  it('o que não rodou sai em `deferred` na ordem de espera de hoje', async () => { // ADR-002
    const w = meteredWorld({});
    const steps = [w.mk('captura', 39, true), w.mk('a', 4), w.mk('b', 4), w.mk('c', 4)];
    const out = await executeRound(steps, ['c', 'a'], w.spent); // #356 AC-4 c e a esperam; só cabe 4 além da captura
    expect(out.ran).toEqual(['captura', 'c']);
    expect(out.deferred).toEqual(['a', 'b']);
  });
});

/** #356 AC-4 40 rodadas sobre os custos declarados do kit (a simulação do revisor), cada passo gastando `spendOf(custo)`. */
async function simulate(spendOf: (declared: number) => number, rounds = 40) {
  const table: [string, number, boolean?][] = [
    ['captura', 18, true], ['recebimentos', 4], ['propostas', 16], ['e8-0', 21], ['e8-1', 21], ['e8-2', 21], ['e8-3', 21], ['doca', 8],
    ['loja', 8], ['devolucoes', 10], ['duplicados', 11], ['prazo', 6], ['claude-dm', 6], ['claude-srr', 12], ['claude-po', 12],
    ['claude-srd', 14], ['motor', 21],
  ];
  let spent = 0;
  const runs = new Map<string, number[]>();
  const perRound: number[] = [];
  const steps: RoundStep[] = table.map(([name, cost, critical]) => ({
    name, maxSubrequests: cost, ...(critical ? { critical } : {}),
    run: async () => { spent += spendOf(cost); },
  }));
  let deferred: readonly string[] = [];
  for (let r = 0; r < rounds; r += 1) {
    const before = spent;
    const out = await executeRound(steps, deferred, () => spent);
    for (const n of out.ran) runs.set(n, [...(runs.get(n) ?? []), r]);
    perRound.push(spent - before);
    deferred = out.deferred;
  }
  return { runs, perRound, names: table.map(([n]) => n) };
}

describe('#356/AC-4 a cadência medida sobre 40 rodadas', () => { // ADR-002
  it('com as filas vazias (gasto real de 1 por passo), todo passo roda em toda rodada', async () => { // ADR-002
    const { runs, names: all } = await simulate(() => 1);
    for (const n of all) expect(runs.get(n)?.length, n).toBe(40);
  });

  it('com as filas cheias, o gasto medido de cada rodada não passa do orçamento e nenhum passo passa fome', async () => { // ADR-002
    const { runs, perRound, names: all } = await simulate((declared) => declared);
    expect(Math.max(...perRound)).toBeLessThanOrEqual(STEP_BUDGET);
    for (const n of all) {
      const at = runs.get(n) ?? [];
      expect(at.length, n).toBeGreaterThan(0);
      const gaps = at.slice(1).map((r, i) => r - (at[i] ?? 0));
      expect(Math.max(0, ...gaps), `a espera de ${n}`).toBeLessThanOrEqual(12);
    }
  });

  it('com metade das filas cheias, a cadência fica entre as duas', async () => { // ADR-002
    const half = await simulate((declared) => Math.ceil(declared / 2));
    const empty = await simulate(() => 1);
    const full = await simulate((declared) => declared);
    const total = (s: Awaited<ReturnType<typeof simulate>>) => [...s.runs.values()].reduce((n, v) => n + v.length, 0);
    expect(total(half)).toBeLessThanOrEqual(total(empty));
    expect(total(half)).toBeGreaterThanOrEqual(total(full));
  });
});
