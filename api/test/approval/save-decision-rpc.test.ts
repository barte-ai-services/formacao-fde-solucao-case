import { describe, expect, it } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import { SupabaseApprovalStore } from '../../src/approval/supabase-store.js';
import { AlreadyDecidedError, EngineApprovalRefusedError, ProposalVersionConflictError } from '../../src/approval/store.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { approve } from '../../src/domain/approval.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { kitInvoice } from './kit.js';

// #304 A decisão do aprovador numa só chamada rpc: aprovação, proposta, título e nota mudam juntos ou nenhum muda.

const NOW = new Date('2026-11-15T12:00:00Z');
const TODAY = '2026-11-15';
const DIRETORIA = 'diretoria@jachegou.test';
const NF080 = kitInvoice('NF-080').accessKey; // #304 diretoria, aguarda aprovação
const RPC = 'save_approval_decision';

async function proposed() {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { captureDeps } = supabaseConnectors(rest);
  await captureInvoices(captureDeps);
  await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, now: () => NOW });
  const store = new SupabaseApprovalStore(rest, () => NOW);
  const find = async (key: string) => {
    const file = await store.find(key);
    if (!file) throw new Error(`proposta da nota ${key} não encontrada`);
    return file;
  };
  const decide = (file: Awaited<ReturnType<typeof find>>, email = DIRETORIA) =>
    approve(file.invoice, file.proposal, file.title, { email, level: 'diretoria' }, { kind: 'aprovar' }, TODAY);
  /** #304 As quatro tabelas da nota, como estão agora. */
  const four = (key: string) => {
    const proposal = fake.rows('proposals').find((r) => r.invoice_access_key === key);
    return structuredClone({
      proposal,
      approvals: fake.rows('approvals').filter((r) => r.proposal_id === proposal?.id),
      title: fake.rows('titles').find((r) => r.invoice_access_key === key),
      invoice: fake.rows('invoices').find((r) => r.access_key === key),
    });
  };
  const writes = () => fake.requests.filter((r) => r.method !== 'GET');
  return { fake, rest, store, find, decide, four, writes };
}

describe('#304/AC-1 a decisão é uma só chamada rpc', () => {
  it('#304/AC-1: saveDecision faz exatamente uma requisição de escrita, o rpc, e as quatro tabelas mudam', async () => {
    const { fake, store, find, decide, four, writes } = await proposed();
    const file = await find(NF080);
    const before = four(NF080);
    const writesBefore = writes().length;

    await store.saveDecision({ ...file, approval: decide(file) });

    const made = writes().slice(writesBefore);
    expect(made.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([`POST /rest/v1/rpc/${RPC}`]);
    const after = four(NF080);
    expect(after.proposal).not.toEqual(before.proposal);
    expect(after.proposal?.state).toBe('aprovada');
    expect(after.proposal?.version).toBe(2);
    expect(after.approvals).toHaveLength(1);
    expect(after.approvals[0]).toMatchObject({ approver: DIRETORIA, approver_level: 'diretoria', decided_on: TODAY });
    expect(after.title?.state).not.toBe(before.title?.state);
    expect(after.invoice?.state).toBe('decidida');
    expect(fake.rows('approvals').filter((r) => r.proposal_id === after.proposal?.id)).toHaveLength(1);
  });

  it('#304/AC-1: o corpo do rpc leva a versão lida e nunca approved_by', async () => {
    const { store, find, decide, writes } = await proposed();
    const file = await find(NF080);
    await store.saveDecision({ ...file, approval: decide(file) });
    const body = writes().find((r) => r.url.includes('/rpc/'))?.body;
    expect(body).toMatchObject({ p_invoice_access_key: NF080, p_version: 1, p_approver: DIRETORIA, p_decided_on: TODAY });
    expect(JSON.stringify(body)).not.toContain('approved_by');
  });

  it('#304/AC-1: sem a versão lida é erro de programação antes de qualquer chamada', async () => {
    const { store, find, decide, writes } = await proposed();
    const file = await find(NF080);
    const writesBefore = writes().length;
    await expect(store.saveDecision({ ...file, version: undefined, approval: decide(file) })).rejects.toThrow(/sem a versão lida/);
    expect(writes()).toHaveLength(writesBefore);
  });

  it('#304/AC-1: a resposta que não é um dos três textos é erro de leitura (corrupt), não decisão gravada', async () => {
    const { fake, store, find, decide } = await proposed();
    const file = await find(NF080);
    fake.failNext(`rpc/${RPC}`, 'POST', 200, 'talvez');
    const error = await store.saveDecision({ ...file, approval: decide(file) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseRestError);
    expect((error as SupabaseRestError).operation).toBe('parse');
  });
});

describe('#304/AC-2 a falha no meio não deixa nenhuma das quatro tabelas mudada', () => {
  it('#304/AC-2: título ausente: o rpc falha e aprovação, proposta e nota ficam como estavam', async () => {
    const { fake, store, find, decide, four } = await proposed();
    const file = await find(NF080);
    fake.tables.set('titles', fake.rows('titles').filter((r) => r.invoice_access_key !== NF080));
    const before = four(NF080);
    const approvalsBefore = fake.rows('approvals').length;

    await expect(store.saveDecision({ ...file, approval: decide(file) })).rejects.toBeInstanceOf(SupabaseRestError);

    expect(four(NF080)).toEqual(before);
    expect(before.approvals).toHaveLength(0);
    expect(fake.rows('approvals')).toHaveLength(approvalsBefore);
  });

  it('#304/AC-2: nota ausente: o rpc falha e aprovação, proposta e título ficam como estavam', async () => {
    const { fake, store, find, decide, four } = await proposed();
    const file = await find(NF080);
    fake.tables.set('invoices', fake.rows('invoices').filter((r) => r.access_key !== NF080));
    const before = four(NF080);

    await expect(store.saveDecision({ ...file, approval: decide(file) })).rejects.toBeInstanceOf(SupabaseRestError);

    expect(four(NF080)).toEqual(before);
  });

  it('#304/AC-2: a falha do banco sobe como veio, sem virar conflito nem decisão repetida', async () => {
    const { fake, store, find, decide } = await proposed();
    const file = await find(NF080);
    fake.failNext(`rpc/${RPC}`, 'POST', 500, { code: 'P0001', message: 'título da nota não encontrado' });
    const error = await store.saveDecision({ ...file, approval: decide(file) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseRestError);
    expect(error).not.toBeInstanceOf(AlreadyDecidedError);
  });
});

describe('#304/AC-3 a segunda decisão recebe AlreadyDecidedError', () => {
  it('#304/AC-3: quem leu a versão antiga e chega depois recebe "já decidida", não conflito de versão, e nada muda', async () => {
    const { store, find, decide, four } = await proposed();
    const a = await find(NF080);
    const b = await find(NF080);
    await store.saveDecision({ ...a, approval: decide(a) });
    const afterFirst = four(NF080);

    const error = await store.saveDecision({ ...b, approval: decide(b, 'outra@jachegou.test') }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AlreadyDecidedError);
    expect((error as Error).name).toBe('AlreadyDecidedError');
    expect(four(NF080)).toEqual(afterFirst);
    expect(afterFirst.approvals).toHaveLength(1);
  });
});

describe('#304/AC-4 versão antiga é conflito e a recusa do motor continua', () => {
  it('#304/AC-4: versão antiga: ProposalVersionConflictError sem gravar nada, nem aprovação, e sem apagar nada', async () => {
    const { fake, rest, store, find, decide, four } = await proposed();
    const stale = await find(NF080);
    await rest.update('proposals', { invoice_access_key: `eq.${NF080}` }, { approval_level: 'bloqueio' });
    const before = four(NF080);
    const approvalsBefore = fake.rows('approvals').length;

    await expect(store.saveDecision({ ...stale, approval: decide(stale) })).rejects.toBeInstanceOf(ProposalVersionConflictError);

    expect(four(NF080)).toEqual(before);
    expect(fake.rows('approvals')).toHaveLength(approvalsBefore);
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('#304/AC-4: o erro do Postgres lido do rpc passa pela recusa do motor como o de um insert', async () => {
    const { fake, store, find } = await proposed();
    const file = await find(NF080);
    const engine = {
      approver: 'motor',
      approverLevel: 'analista',
      dockAction: file.proposal.dockAction,
      justification: 'ok',
      decidedOn: TODAY,
      engine: { decisionId: 1, confidence: null, modelVersion: 'regra-e4-v1' },
    } as const;
    const refuse = async (code: string, message: string) => {
      fake.failNext(`rpc/${RPC}`, 'POST', code === '23505' ? 409 : 400, { code, details: null, hint: null, message });
      return store.saveDecision({ ...file, approval: engine }).catch((e: unknown) => e);
    };
    expect(await refuse('23505', 'duplicate key value violates unique constraint "approvals_proposal_key"')).toBeInstanceOf(AlreadyDecidedError);
    expect(await refuse('23514', 'delegação do nível analista desligada: o motor não aprova')).toMatchObject({
      name: 'EngineApprovalRefusedError',
      reason: 'delegation_off',
    });
    expect(await refuse('23514', 'aprovação do motor não bate com a engine_decision 1')).toBeInstanceOf(EngineApprovalRefusedError);
    expect(await refuse('23503', 'engine_decision 1 não existe')).toMatchObject({ reason: 'mismatch' });
  });

  it('#304/AC-4: o erro do banco numa decisão de pessoa não vira recusa do motor', async () => {
    const { fake, store, find, decide } = await proposed();
    const file = await find(NF080);
    fake.failNext(`rpc/${RPC}`, 'POST', 400, { code: '23514', message: 'delegação desligada' });
    const error = await store.saveDecision({ ...file, approval: decide(file) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseRestError);
  });
});
