// #356 AC-1 a AC-4 A rodada orquestrada, testada contra dublês das portas: sem banco, sem rede.
import { describe, expect, it } from 'vitest';
import { NO_FIGURES, type RunFigures } from '../../src/automation/runs.js';
import { STEP_BUDGET, ROUND_RESERVE, ROUND_LIMIT_MS, type RoundStep } from '../../src/automation/round-budget.js';
import { ASK_TIMEOUT_MS } from '../../src/claude/client.js';
import { ROUND_BUDGET_MS } from '../../src/claude/cron.js';
import {
  LOCK_TTL_MS,
  runNow,
  runRound,
  setDemoMode,
  type RoundBuild,
  type RoundPorts,
  type RoundRecord,
} from '../../src/automation/round.js';

const utc = (hhmm: string) => Date.parse(`2026-11-22T${hhmm}:00Z`);

type StepSpec = { name: string; cost: number; critical?: boolean; fails?: boolean };

/** #356 Um mundo de dublês: o relógio, o modo, a trava com validade e a gravação, e um registro de cada chamada às portas. */
function world(opts: { demo?: boolean; steps?: StepSpec[]; failsRound?: string[]; startAt?: number; buildThrows?: boolean; spends?: Record<string, number>; swallowed?: string[]; refusing?: string[] } = {}) {
  let now = opts.startAt ?? utc('10:15');
  const calls: string[] = [];
  const ran: string[] = [];
  const logs: string[] = [];
  const records: RoundRecord[] = [];
  const lock: { owner: string | null; until: number } = { owner: null, until: 0 };
  const state = {
    demo: opts.demo ?? false,
    deferred: [] as string[],
    stepsBuilt: 0,
    breakRecord: false,
    breakRelease: false,
    breakTake: false,
    owners: 0,
  };
  let spentNow = 0;
  let refusedNow = 0;
  const specs = opts.steps ?? [{ name: 'captura', cost: 10, critical: true }];
  const build = (): RoundBuild => {
    state.stepsBuilt += 1;
    // #356 AC-4 Uma tarefa do Claude sem custo medido: a montagem da rodada lança, já com a trava tomada.
    if (opts.buildThrows) throw new RangeError('a tarefa x não tem custo medido');
    const steps: RoundStep[] = specs.map((s) => ({
      name: s.name,
      maxSubrequests: s.cost,
      ...(s.critical ? { critical: true } : {}),
      run: async () => {
        ran.push(s.name);
        spentNow += opts.spends?.[s.name] ?? s.cost;
        if (opts.refusing?.includes(s.name)) refusedNow += 1;
        if (s.fails) throw new TypeError('texto do erro que não pode ir ao registro');
      },
    }));
    const figures = (): RunFigures => ({ ...NO_FIGURES, seen: ran.length });
    return { steps, figures, failsRound: new Set(opts.failsRound ?? ['captura']), failedSteps: () => opts.swallowed ?? [] };
  };
  const ports: RoundPorts = {
    mode: {
      read: async () => {
        calls.push('modo');
        return { enabled: state.demo, changedAt: null };
      },
      write: async () => {
        calls.push('gravar-modo');
      },
    },
    lock: {
      take: async (owner, validForMs) => {
        calls.push('trava');
        if (lock.owner !== null && lock.until > now) return false;
        Object.assign(lock, { owner, until: now + validForMs });
        // #356 AC-3 O RPC passou do timeout do cliente: o banco gravou a trava, o cliente abortou e `take` lança.
        if (state.breakTake) throw new Error('timeout do cliente');
        return true;
      },
      release: async (owner) => {
        calls.push('soltar');
        if (state.breakRelease) throw new Error('banco fora');
        if (lock.owner === owner) Object.assign(lock, { owner: null, until: 0 });
      },
    },
    history: {
      lastDeferred: async () => {
        calls.push('adiados');
        return state.deferred;
      },
      record: async (r) => {
        calls.push('gravar-rodada');
        if (state.breakRecord) throw new Error('banco fora');
        records.push(r);
        if (r.status !== 'skipped') state.deferred = [...r.deferredSteps];
      },
    },
    buildRound: build,
    newOwner: () => `dono-${(state.owners += 1)}`,
    now: () => new Date(now),
    log: (line) => logs.push(line),
    spent: () => spentNow,
    refused: () => refusedNow,
  };
  return {
    ports,
    calls,
    ran,
    logs,
    records,
    lock,
    state,
    setNow: (t: number) => {
      now = t;
    },
  };
}

describe('#356/AC-1 o disparo e o ritmo', () => { // ADR-002
  it('desligado, o disparo das 10:07 só lê o modo e sai: sem trava, sem passo, sem linha gravada', async () => { // ADR-002
    const w = world({ demo: false });
    const result = await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:07') });
    expect(result).toEqual({ kind: 'off-rhythm' });
    expect(w.calls).toEqual(['modo']);
    expect(w.ran).toEqual([]);
    expect(w.records).toEqual([]);
    expect(w.state.stepsBuilt).toBe(0);
  });

  it('desligado, o disparo das 10:15 roda a rodada de origem cron e modo desligado', async () => { // ADR-002
    const w = world({ demo: false });
    const result = await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(result.kind).toBe('done');
    expect(w.ran).toEqual(['captura']);
    expect(w.records).toHaveLength(1);
    expect(w.records[0]).toMatchObject({ status: 'ok', origin: 'cron', demoEnabled: false, error: null, deferredSteps: [] });
  });

  it('ligado, o disparo de qualquer minuto roda a rodada, com o modo ligado gravado', async () => { // ADR-002
    const w = world({ demo: true });
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:07') });
    expect(w.ran).toEqual(['captura']);
    expect(w.records[0]).toMatchObject({ status: 'ok', origin: 'cron', demoEnabled: true });
  });

  it('a origem manual roda fora do ritmo e grava origem manual', async () => { // ADR-002
    const w = world({ demo: false });
    await runNow(w.ports);
    expect(w.ran).toEqual(['captura']);
    expect(w.records[0]).toMatchObject({ status: 'ok', origin: 'manual', demoEnabled: false });
  });

  it('a linha traz o início e o fim da rodada, do relógio da porta', async () => { // ADR-002
    const w = world();
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(w.records[0]?.startedAt.toISOString()).toBe('2026-11-22T10:15:00.000Z');
    expect(w.records[0]?.finishedAt.getTime()).toBeGreaterThanOrEqual(w.records[0]?.startedAt.getTime() ?? 0);
  });
});

describe('#356/AC-3 a trava', () => { // ADR-002
  it('a rodada toma a trava com dono e validade, e solta só a própria no fim', async () => { // ADR-002
    const w = world();
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(w.calls).toEqual(['modo', 'trava', 'adiados', 'gravar-rodada', 'soltar']);
    expect(w.lock.owner).toBeNull();
  });

  it('com a trava tomada e válida, a segunda não roda passo nenhum e fica gravada como skipped, com origem e modo', async () => { // ADR-002
    const w = world({ demo: true });
    Object.assign(w.lock, { owner: 'outra-rodada', until: utc('10:15') + 60_000 });
    const result = await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(result).toEqual({ kind: 'locked' });
    expect(w.ran).toEqual([]);
    expect(w.state.stepsBuilt).toBe(0);
    expect(w.records).toHaveLength(1);
    expect(w.records[0]).toMatchObject({ status: 'skipped', origin: 'cron', demoEnabled: true, deferredSteps: [], error: null });
    expect(w.lock.owner).toBe('outra-rodada');
    expect(w.calls).not.toContain('soltar');
  });

  it('a rodada manual também respeita a trava e fica skipped com origem manual', async () => { // ADR-002
    const w = world();
    Object.assign(w.lock, { owner: 'outra-rodada', until: utc('10:15') + 60_000 });
    await runNow(w.ports);
    expect(w.ran).toEqual([]);
    expect(w.records[0]).toMatchObject({ status: 'skipped', origin: 'manual' });
  });

  it('a trava vencida (o Worker morreu) é tomada pela rodada seguinte, que roda', async () => { // ADR-002
    const w = world();
    Object.assign(w.lock, { owner: 'worker-morto', until: utc('10:15') });
    w.setNow(utc('10:15') + 1);
    const result = await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(result.kind).toBe('done');
    expect(w.ran).toEqual(['captura']);
  });

  it('a validade da trava passa do limite real de duração da rodada e não segura o modo de 1 minuto por muito tempo', () => { // ADR-002
    // #356 AC-3 o limite real: nenhum fetch novo depois de ROUND_LIMIT_MS (round-meter.ts) mais o que um fetch em curso ainda leva.
    expect(ROUND_BUDGET_MS).toBeLessThan(ROUND_LIMIT_MS); // #356 AC-3 o Claude para de começar tarefa antes do corte
    expect(LOCK_TTL_MS).toBeGreaterThan(ROUND_LIMIT_MS + ASK_TIMEOUT_MS);
    expect(LOCK_TTL_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  it('a trava é pedida com a validade e o dono da rodada', async () => { // ADR-002
    const w = world();
    let asked: { owner: string; validForMs: number } | null = null;
    const take = w.ports.lock.take;
    w.ports.lock.take = async (owner, validForMs) => {
      asked = { owner, validForMs };
      return take(owner, validForMs);
    };
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(asked).toEqual({ owner: 'dono-1', validForMs: LOCK_TTL_MS });
  });
});

describe('#356/AC-4 a gravação e a soltura acontecem sempre', () => { // ADR-002
  it('um passo periférico que falha não derruba a rodada: segue ok e os demais rodam', async () => { // ADR-002
    const w = world({
      steps: [
        { name: 'captura', cost: 10, critical: true },
        { name: 'doca', cost: 5, fails: true },
        { name: 'motor', cost: 5 },
      ],
    });
    const result = await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(w.ran).toEqual(['captura', 'doca', 'motor']);
    expect(w.records[0]?.status).toBe('ok');
    expect(result).toMatchObject({ kind: 'done', status: 'ok' });
    expect(w.logs.join('\n')).toContain('doca');
    expect(w.logs.join('\n')).not.toContain('texto do erro');
  });

  it('um passo que faz a rodada falhar grava failed com a classe do erro, sem a mensagem, e solta a trava', async () => { // ADR-002
    const w = world({ steps: [{ name: 'captura', cost: 10, critical: true, fails: true }, { name: 'motor', cost: 5 }] });
    const result = await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(result).toMatchObject({ kind: 'done', status: 'failed', error: 'TypeError' });
    expect(w.records[0]).toMatchObject({ status: 'failed', error: 'TypeError' });
    expect(JSON.stringify(w.records)).not.toContain('texto do erro');
    expect(w.calls.at(-1)).toBe('soltar');
    expect(w.lock.owner).toBeNull();
  });

  it('#356/AC-3 o take que lança depois de o banco gravar a trava solta com o mesmo dono e relança, sem deixá-la presa', async () => { // ADR-002
    const w = world();
    w.state.breakTake = true;
    await expect(runRound(w.ports, { origin: 'manual' })).rejects.toThrow('timeout do cliente');
    expect(w.calls).toEqual(['modo', 'trava', 'soltar']);
    expect(w.lock.owner).toBeNull();
    expect(w.ran).toEqual([]);
  });

  it('#356/AC-3 se a soltura depois do take que lançou também falha, o erro do take é o que sobe e a classe vai ao log', async () => { // ADR-002
    const w = world();
    w.state.breakTake = true;
    w.state.breakRelease = true;
    await expect(runRound(w.ports, { origin: 'manual' })).rejects.toThrow('timeout do cliente');
    expect(w.logs.join('\n')).not.toContain('banco fora');
  });

  it('um orçamento mal declarado grava a rodada como failed e solta a trava, em vez de deixá-la presa', async () => { // ADR-002
    const w = world({ steps: [{ name: 'gigante', cost: STEP_BUDGET + 1, critical: true }], failsRound: [] });
    const result = await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(result).toMatchObject({ kind: 'done', status: 'failed', error: 'Error' });
    expect(w.records[0]?.status).toBe('failed');
    expect(w.lock.owner).toBeNull();
  });

  it('a falha de gravar a rodada ou de soltar a trava não derruba o Cron: uma linha de log com a classe', async () => { // ADR-002
    const w = world();
    w.state.breakRecord = true;
    w.state.breakRelease = true;
    const result = await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(result.kind).toBe('done');
    const log = w.logs.join('\n');
    expect(log).toContain('Error');
    expect(log).not.toContain('banco fora');
  });

  it('o uso das portas pela rodada cabe na reserva do orçamento (uma requisição por chamada)', async () => { // ADR-002
    const w = world();
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(w.calls.length).toBeLessThanOrEqual(ROUND_RESERVE);
    const skipped = world();
    Object.assign(skipped.lock, { owner: 'outra', until: utc('10:15') + 60_000 });
    await runRound(skipped.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(skipped.calls.length).toBeLessThanOrEqual(ROUND_RESERVE);
  });

  it('o passo que não coube fica registrado em deferred_steps e roda na rodada seguinte, sem fome', async () => { // ADR-002
    const w = world({
      steps: [
        { name: 'captura', cost: 10, critical: true },
        { name: 'a', cost: 20 },
        { name: 'b', cost: 20 },
      ],
    });
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(w.ran).toEqual(['captura', 'a']);
    expect(w.records[0]?.deferredSteps).toEqual(['b']);
    w.ran.length = 0;
    w.setNow(utc('10:30'));
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:30') });
    expect(w.ran).toEqual(['captura', 'b']);
    expect(w.records[1]?.deferredSteps).toEqual(['a']);
    w.ran.length = 0;
    w.setNow(utc('10:45'));
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:45') });
    expect(w.ran).toEqual(['captura', 'a']);
  });

  it('a rodada pulada não apaga os adiados: a seguinte ainda os lê da última rodada que rodou', async () => { // ADR-002
    const w = world({ steps: [{ name: 'captura', cost: 10, critical: true }, { name: 'a', cost: 20 }, { name: 'b', cost: 20 }] });
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    Object.assign(w.lock, { owner: 'outra', until: utc('10:30') + 60_000 });
    w.setNow(utc('10:30'));
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:30') });
    expect(w.state.deferred).toEqual(['b']);
  });

  it('o custo dos passos que rodam, somado à reserva, nunca passa do teto de 50', async () => { // ADR-002
    const w = world({ steps: [{ name: 'captura', cost: 10, critical: true }, { name: 'a', cost: 30 }, { name: 'b', cost: 30 }] });
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(w.ran).toEqual(['captura', 'a']);
    expect(10 + 30 + ROUND_RESERVE).toBeLessThanOrEqual(50);
  });
});

describe('#356/AC-3 a montagem da rodada, já com a trava tomada', () => { // ADR-002
  it('se a montagem lança, a rodada fica gravada como failed com a classe do erro e a trava é solta', async () => { // ADR-002
    const w = world({ buildThrows: true });
    const result = await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(result).toMatchObject({ kind: 'done', status: 'failed', error: 'RangeError', deferred: [] });
    expect(w.records[0]).toMatchObject({ status: 'failed', error: 'RangeError', origin: 'cron' });
    expect(JSON.stringify(w.records)).not.toContain('custo medido');
    expect(w.ran).toEqual([]);
    expect(w.calls.at(-1)).toBe('soltar');
    expect(w.lock.owner).toBeNull();
  });

  it('os adiados da rodada anterior ficam como estavam quando a montagem lança', async () => { // ADR-002
    const w = world({ buildThrows: true });
    w.state.deferred = ['b'];
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(w.records[0]?.deferredSteps).toEqual(['b']);
  });
});

describe('#356/AC-4 a admissão pelo gasto medido na rodada', () => { // ADR-002
  const specs: StepSpec[] = [{ name: 'captura', cost: 10, critical: true }, { name: 'a', cost: 20 }, { name: 'b', cost: 20 }];

  it('com a fila vazia o passo que não cabia pela conta declarada roda na mesma rodada', async () => { // ADR-002
    const w = world({ steps: specs, spends: { captura: 1, a: 1, b: 1 } });
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(w.ran).toEqual(['captura', 'a', 'b']);
    expect(w.records[0]?.deferredSteps).toEqual([]);
  });

  it('o passo que gasta mais que o declarado vai ao log com o nome, o declarado e o medido', async () => { // ADR-002
    const w = world({ steps: specs, spends: { a: 35 } });
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(w.logs.join('\n')).toContain('passo a gastou 35 subrequests, declarou 20');
    expect(w.records[0]?.status).toBe('ok');
  });
});

describe('#356/AC-2 ligar e desligar o modo demonstração', () => { // ADR-002
  it('grava o estado novo com quem mudou (o e-mail do Access) e quando', async () => { // ADR-002
    const w = world();
    let written: unknown = null;
    w.ports.mode.write = async (change) => {
      written = change;
    };
    const result = await setDemoMode(w.ports, { enabled: true, changedBy: 'ana@jachegou.test' });
    expect(written).toEqual({ enabled: true, changedBy: 'ana@jachegou.test', changedAt: new Date(utc('10:15')) });
    expect(result).toEqual({ enabled: true, changedAt: '2026-11-22T10:15:00.000Z' });
  });

  it('um service token, sem e-mail, grava quem mudou como nulo', async () => { // ADR-002
    const w = world();
    let written: { changedBy: string | null } | null = null;
    w.ports.mode.write = async (change) => {
      written = change;
    };
    await setDemoMode(w.ports, { enabled: false, changedBy: null });
    expect(written).toMatchObject({ changedBy: null, enabled: false });
  });
});

describe('#311 cada passo falha sozinho e a rodada grava o rastro e o gasto', () => { // ADR-002
  it('o passo que lançou e o que engoliu a própria falha entram em failedSteps, sem repetir, e a rodada segue ok', async () => { // ADR-002
    const w = world({
      steps: [{ name: 'captura', cost: 10, critical: true }, { name: 'doca', cost: 5, fails: true }, { name: 'motor', cost: 5 }],
      swallowed: ['registry-e8', 'doca'],
    });
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(w.records[0]).toMatchObject({ status: 'ok', error: null });
    expect(w.records[0]?.failedSteps).toEqual(['registry-e8', 'doca']);
  });

  it('o passo cuja chamada o medidor recusou, sem lançar, também entra em failedSteps', async () => { // ADR-002
    const w = world({ steps: [{ name: 'captura', cost: 10, critical: true }, { name: 'loja', cost: 5 }], refusing: ['loja'] });
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(w.records[0]?.failedSteps).toEqual(['loja']);
    expect(w.records[0]?.status).toBe('ok');
  });

  it('a captura que falha é o status failed e não entra em failedSteps; a rodada sem falha grava a lista vazia', async () => { // ADR-002
    const failing = world({ steps: [{ name: 'captura', cost: 10, critical: true, fails: true }] });
    await runRound(failing.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(failing.records[0]).toMatchObject({ status: 'failed', failedSteps: [] });
    const quiet = world();
    await runRound(quiet.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(quiet.records[0]?.failedSteps).toEqual([]);
  });

  it('grava os subrequests da invocação: o medido mais a própria gravação; sem medidor, nulo; a pulada grava o que gastou até ali', async () => { // ADR-002
    const w = world({ steps: [{ name: 'captura', cost: 10, critical: true }] });
    await runRound(w.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(w.records[0]?.subrequests).toBe(11);
    const bare = world();
    const { spent: _spent, ...withoutMeter } = bare.ports;
    await runRound(withoutMeter, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(bare.records[0]?.subrequests).toBeNull();
    const skipped = world();
    skipped.lock.owner = 'outro';
    skipped.lock.until = utc('10:15') + 60_000;
    await runRound(skipped.ports, { origin: 'cron', scheduledTime: utc('10:15') });
    expect(skipped.records[0]).toMatchObject({ status: 'skipped', failedSteps: [], subrequests: 1 });
  });

  it('a gravação e a soltura seguem logo depois dos passos, sem porta de fim de fase', async () => { // ADR-002
    const w = world();
    await runNow(w.ports);
    expect(w.calls).toEqual(['modo', 'trava', 'adiados', 'gravar-rodada', 'soltar']);
  });
});
