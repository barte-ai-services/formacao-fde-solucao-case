import { describe, expect, it } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import { SupabaseApprovalStore } from '../../src/approval/supabase-store.js';
import { AlreadyDecidedError, ProposalVersionConflictError } from '../../src/approval/store.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { approve } from '../../src/domain/approval.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { kitInvoice } from './kit.js';

// #295 A trava otimista da proposta: `proposals.version` sobe a cada escrita, e a decisão só vale se a versão lida ainda é a atual.

const NOW = new Date('2026-11-15T12:00:00Z');
const TODAY = '2026-11-15';
const DIRETORIA = 'diretoria@jachegou.test';
const NF080 = kitInvoice('NF-080').accessKey; // diretoria, aguarda aprovação
const NF036 = kitInvoice('NF-036').accessKey; // regra, aprovada sem pessoa

async function proposed() {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { captureDeps } = supabaseConnectors(rest);
  await captureInvoices(captureDeps);
  await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, now: () => NOW });
  const store = new SupabaseApprovalStore(rest, () => NOW);
  const row = (key: string) => fake.rows('proposals').find((r) => r.invoice_access_key === key);
  const find = async (key: string) => {
    const file = await store.find(key);
    if (!file) throw new Error(`proposta da nota ${key} não encontrada`);
    return file;
  };
  const decide = (file: Awaited<ReturnType<typeof find>>, email = DIRETORIA) =>
    approve(file.invoice, file.proposal, file.title, { email, level: 'diretoria' }, { kind: 'aprovar' }, TODAY);
  return { fake, rest, store, row, find, decide };
}

describe('#295/AC-1 a versão da proposta sobe a cada escrita', () => {
  it('#295/AC-1: a proposta nasce com a versão 1, aprovada pela regra ou aguardando uma pessoa', async () => {
    const { row } = await proposed();
    expect(row(NF080)?.version).toBe(1);
    expect(row(NF036)?.version).toBe(1);
  });

  it('#295/AC-1: a decisão gravada sobe a versão para 2 e a leitura traz a versão lida', async () => {
    const { store, row, find, decide } = await proposed();
    const file = await find(NF080);
    expect(file.version).toBe(1);
    await store.saveDecision({ ...file, approval: decide(file) });
    expect(row(NF080)?.version).toBe(2);
    expect((await find(NF080)).version).toBe(2);
  });

  it('#295/AC-1: a subida de nível (qualquer update na linha) também sobe a versão, mesmo que o cliente mande outra', async () => {
    const { rest, row } = await proposed();
    await rest.update('proposals', { invoice_access_key: `eq.${NF080}` }, { approval_level: 'bloqueio', version: 99 });
    expect(row(NF080)?.version).toBe(2);
  });
});

describe('#295/AC-2 a escrita com versão antiga é conflito', () => {
  it('#295/AC-2: a linha mudou entre a leitura e a gravação: lança o conflito e não muda proposta, aprovação, título nem nota', async () => {
    const { fake, rest, store, row, find, decide } = await proposed();
    const stale = await find(NF080);
    const before = {
      proposal: { ...row(NF080) },
      title: { ...fake.rows('titles').find((r) => r.invoice_access_key === NF080) },
      invoice: { ...fake.rows('invoices').find((r) => r.access_key === NF080) },
    };
    // outra escrita chega primeiro e sobe a versão para 2
    await rest.update('proposals', { invoice_access_key: `eq.${NF080}` }, { approval_level: 'bloqueio' });
    const afterOther = { ...row(NF080) };

    await expect(store.saveDecision({ ...stale, approval: decide(stale) })).rejects.toBeInstanceOf(ProposalVersionConflictError);

    expect(row(NF080)).toEqual(afterOther);
    expect(row(NF080)?.state).toBe(before.proposal.state);
    expect(row(NF080)?.dock_action).toEqual(before.proposal.dock_action);
    expect(row(NF080)?.justification).toBe(before.proposal.justification);
    const proposalId = row(NF080)?.id;
    expect(fake.rows('approvals').filter((r) => r.proposal_id === proposalId)).toHaveLength(0);
    expect(fake.rows('titles').find((r) => r.invoice_access_key === NF080)).toEqual(before.title);
    expect(fake.rows('invoices').find((r) => r.access_key === NF080)).toEqual(before.invoice);
  });

  it('#295/AC-2: o conflito é um AlreadyDecidedError, para a API devolver 409 e o motor deixar a proposta com a pessoa', async () => {
    const { rest, store, find, decide } = await proposed();
    const stale = await find(NF080);
    await rest.update('proposals', { invoice_access_key: `eq.${NF080}` }, { approval_level: 'bloqueio' });
    const error = await store.saveDecision({ ...stale, approval: decide(stale) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlreadyDecidedError);
    expect((error as Error).name).toBe('ProposalVersionConflictError');
    expect((error as Error).message).toMatch(/mudou desde a leitura/);
  });

  it('#295/AC-2: sem a versão lida é erro de programação antes de qualquer escrita: nada é gravado', async () => {
    const { fake, store, row, find, decide } = await proposed();
    const file = await find(NF080);
    const before = structuredClone([...fake.tables.entries()]);
    const writes = () => fake.requests.filter((r) => r.method !== 'GET').length;
    const writesBefore = writes();
    const error = await store.saveDecision({ ...file, version: undefined, approval: decide(file) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AlreadyDecidedError);
    expect((error as Error).message).toMatch(/sem a versão lida/);
    expect([...fake.tables.entries()]).toEqual(before);
    expect(row(NF080)?.state).toBe('aguardando_aprovacao');
    expect(writes()).toBe(writesBefore);
  });

  it('#295/AC-2: a compensação apaga só a aprovação desta chamada, pelo id da linha inserida', async () => {
    const { fake, rest, store, find, decide } = await proposed();
    const stale = await find(NF080);
    await rest.update('proposals', { invoice_access_key: `eq.${NF080}` }, { approval_level: 'bloqueio' });
    const approvalsBefore = fake.rows('approvals').length;
    await store.saveDecision({ ...stale, approval: decide(stale) }).catch(() => undefined);
    const del = fake.requests.find((r) => r.method === 'DELETE');
    expect(new URL(del?.url ?? '').searchParams.get('id')).toMatch(/^eq\.\d+$/);
    expect(new URL(del?.url ?? '').searchParams.has('proposal_id')).toBe(false);
    expect(fake.rows('approvals')).toHaveLength(approvalsBefore);
  });

  it('#295/AC-2: o delete da compensação falhando não troca o erro devolvido, e o log traz a chave e só o nome do erro', async () => {
    const { fake, rest, find, decide } = await proposed();
    const stale = await find(NF080);
    await rest.update('proposals', { invoice_access_key: `eq.${NF080}` }, { approval_level: 'bloqueio' });
    fake.failNext('approvals', 'DELETE', 500, { message: 'segredo-do-banco-xyz' });
    const failing = new SupabaseApprovalStore(rest, () => NOW);
    const lines: string[] = [];
    const spy = console.error;
    console.error = (l: unknown) => void lines.push(String(l));
    let error: unknown;
    try {
      error = await failing.saveDecision({ ...stale, approval: decide(stale) }).catch((e: unknown) => e);
    } finally {
      console.error = spy;
    }
    expect(error).toBeInstanceOf(ProposalVersionConflictError);
    expect(lines.join('\n')).toContain(NF080);
    expect(lines.join('\n')).toContain('#295');
    expect(lines.join('\n')).toContain('SupabaseRestError');
    expect(lines.join('\n')).not.toContain('segredo-do-banco-xyz');
  });

  it('#295/AC-2: o PATCH da proposta filtra pela versão lida e não leva a versão no corpo', async () => {
    const { fake, store, find, decide } = await proposed();
    const file = await find(NF080);
    await store.saveDecision({ ...file, approval: decide(file) });
    const patch = fake.requests.find((r) => r.method === 'PATCH' && r.url.includes('/proposals?'));
    expect(new URL(patch?.url ?? '').searchParams.get('version')).toBe('eq.1');
    expect(patch?.body).not.toHaveProperty('version');
  });
});

describe('#295/AC-3 a restrição única de approvals decide quem chegou antes', () => {
  it('#295/AC-3: duas decisões na mesma versão: a primeira grava, a segunda recebe AlreadyDecidedError e nada muda', async () => {
    const { fake, store, row, find, decide } = await proposed();
    const a = await find(NF080);
    const b = await find(NF080);
    await store.saveDecision({ ...a, approval: decide(a) });
    const afterFirst = { proposal: { ...row(NF080) }, titles: structuredClone(fake.rows('titles')) };

    const error = await store.saveDecision({ ...b, approval: decide(b, 'outra@jachegou.test') }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AlreadyDecidedError);
    expect(error).not.toBeInstanceOf(ProposalVersionConflictError);
    expect(row(NF080)).toEqual(afterFirst.proposal);
    expect(fake.rows('titles')).toEqual(afterFirst.titles);
    const proposalId = row(NF080)?.id;
    expect(fake.rows('approvals').filter((r) => r.proposal_id === proposalId)).toHaveLength(1);
  });
});
