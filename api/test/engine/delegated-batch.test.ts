// #371 O motor decide em lote: as decisões da rodada gravam numa chamada só e a releitura das propostas antes de aprovar é uma só para o lote,
// #371 para o passo caber toda rodada no caminho fixo do modo demonstração (custo medido em test/cron/round-fixed-path-budget.test.ts).
import { describe, expect, it, vi } from 'vitest';
import { MemoryApprovalStore, type ApprovalStore, type CaseFile } from '../../src/approval/store.js';
import { SupabaseApprovalStore } from '../../src/approval/supabase-store.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { DEFAULT_ANALYST_SETTINGS, RULE_VERSION, type EngineDecision } from '../../src/engine/decision.js';
import { runDelegatedRound, type DelegatedDeps } from '../../src/engine/delegated.js';
import { MemoryEngineStore } from '../../src/engine/store.js';
import { SupabaseEngineStore } from '../../src/engine/supabase-store.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { caseFile, FakeClef } from './support.js';

const ON = { ...DEFAULT_ANALYST_SETTINGS, delegationEnabled: true };
const deps = (over: Partial<DelegatedDeps> & { approvals: DelegatedDeps['approvals'] }): DelegatedDeps => ({
  store: new MemoryEngineStore([ON]),
  clef: new FakeClef(async () => ({ response: { outcome: 'approve', confidence: 0.99, reason: 'ok' } })),
  today: () => '2026-11-23',
  ...over,
});

describe('#371 o motor grava as decisões da rodada em lote', () => { // ADR-002
  it('quatro notas que a regra aprova: uma gravação em lote e as quatro aprovadas', async () => { // ADR-002
    const approvals = new MemoryApprovalStore([caseFile(), caseFile(), caseFile(), caseFile()]);
    const store = new MemoryEngineStore([ON]);
    const many = vi.spyOn(store, 'recordMany');
    const round = await runDelegatedRound(deps({ approvals, store, decisionLimit: 4 }), ON);
    expect(round).toMatchObject({ evaluated: 4, approved: 4, deferred: 0, errors: 0 });
    expect(many).toHaveBeenCalledTimes(1);
    expect(many.mock.calls[0]?.[0]).toHaveLength(4);
    expect(store.decisions.map((d) => d.id)).toEqual([1, 2, 3, 4]);
  });

  it('a nota que já tem a cascata gravada não entra de novo, e a outra segue', async () => {  // ADR-002
    const [taken, free] = [caseFile(), caseFile()];
    const approvals = new MemoryApprovalStore([taken, free]);
    const store = new MemoryEngineStore([ON]);
    await store.recordWithId({ invoiceAccessKey: taken.invoice.accessKey, mode: 'delegated', role: 'cascade', outcome: 'pending', decidedBy: 'person', confidence: null, modelVersion: RULE_VERSION, reason: 'antes', pendingReason: 'outside_criteria', error: null, latencyMs: null } satisfies EngineDecision);
    const round = await runDelegatedRound(deps({ approvals, store }), ON);
    // a nota `taken` já tem cascata: a rodada nem a pega; só a livre entra
    expect(round).toMatchObject({ evaluated: 1, approved: 1 });
  });

  it('a releitura antes de aprovar é uma para o lote (reread), e a nota que a pessoa decidiu no meio fica com ela', async () => { // ADR-002
    const [mine, theirs] = [caseFile(), caseFile()];
    const memory = new MemoryApprovalStore([mine, theirs]);
    const find = vi.fn((key: string) => memory.find(key));
    const reread = vi.fn(async (files: readonly CaseFile[]) => new Set(files.map((f) => f.invoice.accessKey).filter((k) => k !== theirs.invoice.accessKey)));
    const saved: string[] = [];
    const approvals: DelegatedDeps['approvals'] = {
      listAwaiting: () => memory.listAwaiting(),
      find,
      reread,
      saveDecision: async (f) => void saved.push(f.invoice.accessKey),
    };
    const round = await runDelegatedRound(deps({ approvals }), ON);
    expect(round).toMatchObject({ evaluated: 2, approved: 1, keptWithPerson: 1, errors: 0 });
    expect(reread).toHaveBeenCalledTimes(1);
    expect(find).not.toHaveBeenCalled();
    expect(saved).toEqual([mine.invoice.accessKey]);
  });

  it('sem reread na porta, cada aprovação relê pelo find, como antes', async () => { // ADR-002
    const memory = new MemoryApprovalStore([caseFile(), caseFile()]);
    const find = vi.fn((key: string) => memory.find(key));
    const approvals: Pick<ApprovalStore, 'listAwaiting' | 'find' | 'saveDecision'> = {
      listAwaiting: () => memory.listAwaiting(),
      find,
      saveDecision: (f) => memory.saveDecision(f),
    };
    await runDelegatedRound(deps({ approvals }), ON);
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('o que não tem aprovação a gravar (pendência) não gasta releitura', async () => { // ADR-002
    const excluded = caseFile({ extra: ['E6'] });
    const memory = new MemoryApprovalStore([excluded]);
    const reread = vi.fn(async () => new Set<string>());
    const round = await runDelegatedRound(deps({ approvals: { listAwaiting: () => memory.listAwaiting(), find: (k) => memory.find(k), reread, saveDecision: (f) => memory.saveDecision(f) } }), ON);
    expect(round).toMatchObject({ evaluated: 1, approved: 0 });
    expect(reread).not.toHaveBeenCalled();
  });
});

const KEYS = ['35261194433432000143550010000894281178831290', '35261194433432000143550010000894281178831291', '35261194433432000143550010000894281178831292'];
const decision = (invoiceAccessKey: string): EngineDecision => ({
  invoiceAccessKey, mode: 'delegated', role: 'cascade', outcome: 'approve', decidedBy: 'rule', confidence: null, modelVersion: RULE_VERSION,
  reason: 'fecha', pendingReason: null, error: null, latencyMs: null,
});

describe('#371 a loja do motor no Supabase grava o lote com uma leitura e uma gravação', () => { // ADR-002
  const world = () => {
    const fake = new FakePostgrest({ proposals: KEYS.map((k, i) => ({ id: i + 1, invoice_access_key: k, state: 'aguardando_aprovacao', version: 1 })) });
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'k', fetch: fake.fetch });
    return { fake, store: new SupabaseEngineStore(rest) };
  };

  it('três decisões: duas requisições (as propostas e a gravação), e um id por decisão, na ordem', async () => { // ADR-002
    const { fake, store } = world();
    const ids = await store.recordMany(KEYS.map(decision));
    expect(fake.requests).toHaveLength(2);
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => typeof id === 'number')).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  it('uma decisão que bate na unicidade de cascata (23505) cai para a gravação uma a uma: a conflitante é nula e as outras entram', async () => { // ADR-002
    const { fake, store } = world();
    fake.unique('engine_decisions', ['proposal_id', 'mode'], (r) => r.role === 'cascade');
    await store.recordWithId({ ...decision(KEYS[1] as string), modelVersion: 'versao-antiga' });
    fake.requests.length = 0;
    const ids = await store.recordMany(KEYS.map(decision));
    expect(ids.map((id) => id === null)).toEqual([false, true, false]);
  });

  it('o lote vazio não faz requisição', async () => { // ADR-002
    const { fake, store } = world();
    expect(await store.recordMany([])).toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });

  it('o que já foi avaliado, só da cascata, é uma leitura em vez de duas', async () => { // ADR-002
    const { fake, store } = world();
    await store.evaluated('delegated', 'clef-v1', { cascadeOnly: true });
    expect(fake.requests).toHaveLength(1);
    fake.requests.length = 0;
    await store.evaluated('delegated', 'clef-v1');
    expect(fake.requests).toHaveLength(2);
  });
});

describe('#371 a loja da aprovação relê o lote em duas requisições', () => { // ADR-002
  const row = (id: number, key: string, over: Record<string, unknown> = {}) => ({ id, invoice_access_key: key, state: 'aguardando_aprovacao', version: 1, ...over });

  it('devolve as chaves que seguem aguardando na versão lida e deixa de fora a que mudou de versão, a que já tem aprovação e a que sumiu', async () => { // ADR-002
    const fake = new FakePostgrest({
      proposals: [row(1, KEYS[0] as string), row(2, KEYS[1] as string, { version: 2 }), row(3, KEYS[2] as string)],
      approvals: [{ id: 9, proposal_id: 3 }],
    });
    const store = new SupabaseApprovalStore(new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'k', fetch: fake.fetch }));
    const read = (key: string): CaseFile => ({ ...caseFile({ key }), version: 1 });
    const still = await store.reread([...KEYS.map(read), read('35261194433432000143550010000894281178839999')]);
    expect([...still]).toEqual([KEYS[0]]);
    expect(fake.requests).toHaveLength(2);
  });
});
