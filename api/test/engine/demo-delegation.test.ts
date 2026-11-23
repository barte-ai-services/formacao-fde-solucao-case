// #351 Com o modo demonstração ligado, a delegação do analista liga sozinha; desligado o modo, volta ao valor de antes.
// A régua (routeDivergences) continua decidindo o nível: diretoria e bloqueio nunca saem da pessoa.
import { describe, expect, it } from 'vitest';
import { MemoryApprovalStore } from '../../src/approval/store.js';
import { DEFAULT_ANALYST_SETTINGS } from '../../src/engine/decision.js';
import { runEngineRound, type DelegatedDeps } from '../../src/engine/delegated.js';
import { MemoryEngineStore } from '../../src/engine/store.js';
import { caseFile, FakeClef } from './support.js';

const TODAY = '2026-11-23';
const clef = () => new FakeClef(async () => ({ response: { outcome: 'approve', confidence: 0.99, reason: 'ok' } }));
const build = (store: MemoryEngineStore, approvals: MemoryApprovalStore, demo: () => Promise<boolean>): DelegatedDeps => ({
  store,
  approvals,
  clef: clef(),
  today: () => TODAY,
  demoMode: demo,
});

describe('#351 delegação condicionada ao modo demonstração', () => {
  it('AC-1 modo ligado e delegação desligada: liga a delegação e o motor aprova a E4 do analista sem clique', async () => {
    const file = caseFile();
    const approvals = new MemoryApprovalStore([file]);
    const store = new MemoryEngineStore([DEFAULT_ANALYST_SETTINGS]);

    const round = await runEngineRound(build(store, approvals, async () => true));

    expect(round).toMatchObject({ mode: 'delegated', approved: 1 });
    expect((await store.settings('analista')).delegationEnabled).toBe(true);
    expect((await approvals.find(file.invoice.accessKey))?.approval?.approver).toBe('motor');
  });

  it('AC-3 desligar o modo devolve a delegação ao valor de antes (desligada)', async () => {
    const store = new MemoryEngineStore([DEFAULT_ANALYST_SETTINGS]);
    const approvals = new MemoryApprovalStore([]);
    await runEngineRound(build(store, approvals, async () => true));
    const round = await runEngineRound(build(store, approvals, async () => false));

    expect(round.mode).toBe('shadow');
    expect((await store.settings('analista')).delegationEnabled).toBe(false);
  });

  it('AC-3 se a delegação já estava ligada antes do modo, desligar o modo a deixa ligada', async () => {
    const store = new MemoryEngineStore([{ ...DEFAULT_ANALYST_SETTINGS, delegationEnabled: true }]);
    const approvals = new MemoryApprovalStore([]);
    await runEngineRound(build(store, approvals, async () => true));
    await runEngineRound(build(store, approvals, async () => false));

    expect((await store.settings('analista')).delegationEnabled).toBe(true);
  });

  it('modo ligado por várias rodadas não perde o valor de antes', async () => {
    const store = new MemoryEngineStore([DEFAULT_ANALYST_SETTINGS]);
    const approvals = new MemoryApprovalStore([]);
    for (let i = 0; i < 3; i++) await runEngineRound(build(store, approvals, async () => true));
    await runEngineRound(build(store, approvals, async () => false));

    expect((await store.settings('analista')).delegationEnabled).toBe(false);
  });

  it('sem a leitura do modo, nada muda (comportamento de antes)', async () => {
    const store = new MemoryEngineStore([DEFAULT_ANALYST_SETTINGS]);
    const deps = build(store, new MemoryApprovalStore([]), async () => true);
    const { demoMode: _omit, ...without } = deps;
    const round = await runEngineRound(without);

    expect(round.mode).toBe('shadow');
    expect((await store.settings('analista')).delegationEnabled).toBe(false);
  });

  it('a leitura do modo que falha não mexe na delegação', async () => {
    const store = new MemoryEngineStore([DEFAULT_ANALYST_SETTINGS]);
    const round = await runEngineRound(
      build(store, new MemoryApprovalStore([]), async () => {
        throw new Error('falha');
      }),
    );

    expect(round.mode).toBe('shadow');
    expect((await store.settings('analista')).delegationEnabled).toBe(false);
  });

  it('AC-4 com o modo ligado, o nível que a régua manda para a diretoria fica com a pessoa', async () => {
    const big = caseFile({ level: 'diretoria' });
    const approvals = new MemoryApprovalStore([big]);
    const store = new MemoryEngineStore([DEFAULT_ANALYST_SETTINGS]);

    const round = await runEngineRound(build(store, approvals, async () => true));

    expect(round).toMatchObject({ mode: 'delegated', approved: 0 });
    expect((await approvals.find(big.invoice.accessKey))?.approval).toBeNull();
  });
});
