import { describe, expect, it } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import { SupabaseApprovalStore } from '../../src/approval/supabase-store.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { kitInvoice } from './kit.js';

// #63 O fluxo inteiro sobre as tabelas do domínio (#59), com a base do kit num PostgREST falso.
// As contagens dependem das verificações das outras histórias; aqui só o que é desta.

const NOW = new Date('2026-11-15T12:00:00Z');
const TODAY = '2026-11-15';
const DIRETORIA = 'diretoria@jachegou.test';
const COORDENACAO = 'coordenacao@jachegou.test';
const env: Env = {
  ACCESS_AUD: 'aud',
  ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com',
  APPROVER_LEVELS: JSON.stringify({ [DIRETORIA]: 'diretoria', [COORDENACAO]: 'coordenacao' }),
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const verifier: AccessVerifier = { verify: async (token) => ({ ok: true, identity: { email: token } }) };

async function captured() {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { captureDeps } = supabaseConnectors(rest);
  await captureInvoices(captureDeps);
  const deps = { rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, now: () => NOW };
  const store = new SupabaseApprovalStore(rest, () => NOW);
  const worker = createWorker({ verifier, approval: { store, today: () => TODAY } });
  const call = (path: string, as: string, method = 'GET') =>
    worker.fetch(new Request(`https://worker.test${path}`, { method, headers: { 'Cf-Access-Jwt-Assertion': as } }), env, ctx);
  return { fake, deps, store, call };
}

const NF080 = kitInvoice('NF-080').accessKey; // F12, pagamento bloqueado: diretoria
const NF036 = kitInvoice('NF-036').accessKey; // dentro da tolerância: regra

describe('#63 proposta no Cron, depois da conferência', () => {
  it('propõe uma vez para cada nota conferida; a segunda rodada não propõe de novo', async () => {
    const { fake, deps } = await captured();
    const first = await proposeChecked(deps);
    const second = await proposeChecked(deps);
    expect(first.proposed).toBe(80);
    expect(second).toEqual({ proposed: 0, approvedByRule: 0 });
    expect(fake.rows('proposals')).toHaveLength(80);
    expect(fake.rows('titles')).toHaveLength(80);
    expect(fake.rows('invoices').every((r) => r.state === 'com_proposta' || r.state === 'decidida')).toBe(true);
  });

  it('AC-1: o match é aprovado pela regra, sem pessoa, e o título vai para a lista do dia', async () => {
    const { fake, deps, store } = await captured();
    await proposeChecked(deps);
    const nf036 = await store.find(NF036);
    expect(nf036?.proposal.state).toBe('aprovada');
    expect(nf036?.approval).toMatchObject({ approver: 'regra', approverLevel: 'regra', decidedOn: TODAY });
    expect(nf036?.title.state).toBe('na_lista_do_dia');
    expect(fake.rows('proposals').find((r) => r.invoice_access_key === NF036)?.regua_line).toBe(6);
  });

  it('AC-4 e AC-6: a nota do fornecedor bloqueado aguarda a diretoria na fila', async () => {
    const { deps, store } = await captured();
    await proposeChecked(deps);
    const awaiting = await store.listAwaiting();
    const nf080 = awaiting.find((f) => f.invoice.accessKey === NF080);
    expect(nf080).toMatchObject({ route: { level: 'diretoria', line: 2 } });
    expect(awaiting.every((f) => f.proposal.level !== 'regra')).toBe(true);
  });
});

describe('#63 aprovação gravada no Supabase', () => {
  it('AC-7, AC-8 e AC-11: só a diretoria aprova, uma vez só, e o título vai para a lista do dia', async () => {
    const { fake, deps, call } = await captured();
    await proposeChecked(deps);
    expect((await call(`/api/propostas/${NF080}/aprovar`, COORDENACAO, 'POST')).status).toBe(403);
    expect((await call(`/api/propostas/${NF080}/aprovar`, DIRETORIA, 'POST')).status).toBe(200);
    expect((await call(`/api/propostas/${NF080}/aprovar`, DIRETORIA, 'POST')).status).toBe(409);

    const approvals = fake.rows('approvals').filter((r) => r.approver === DIRETORIA);
    expect(approvals).toHaveLength(1);
    expect(fake.rows('titles').find((r) => r.invoice_access_key === NF080)?.state).toBe('na_lista_do_dia');
    expect(fake.rows('invoices').find((r) => r.access_key === NF080)?.state).toBe('decidida');
  });

  it('AC-8: a corrida entre duas aprovações grava uma só', async () => {
    const { deps, store } = await captured();
    await proposeChecked(deps);
    const a = await store.find(NF080);
    const b = await store.find(NF080);
    if (!a || !b) throw new Error('proposta da NF-080 não encontrada');
    const { approve } = await import('../../src/domain/approval.js');
    const approval = approve(a.invoice, a.proposal, a.title, { email: DIRETORIA, level: 'diretoria' }, { kind: 'aprovar' }, TODAY);
    const other = approve(b.invoice, b.proposal, b.title, { email: 'outra@jachegou.test', level: 'diretoria' }, { kind: 'aprovar' }, TODAY);
    await store.saveDecision({ ...a, approval });
    await expect(store.saveDecision({ ...b, approval: other })).rejects.toThrow(/já foi decidida/);
  });

  it('AC-13: a lista do dia traz os liberados de hoje e nenhum bloqueado ou sem decisão', async () => {
    const { deps, call } = await captured();
    await proposeChecked(deps);
    const res = await call('/api/hoje', DIRETORIA);
    const body = (await res.json()) as { items: { invoiceAccessKey: string }[] };
    const keys = body.items.map((i) => i.invoiceAccessKey);
    expect(keys).toContain(NF036);
    expect(keys).not.toContain(NF080);

    const fila = (await (await call('/api/fila', DIRETORIA)).json()) as { items: { invoiceAccessKey: string }[] };
    for (const item of fila.items) expect(keys).not.toContain(item.invoiceAccessKey);
  });

  it('AC-12: a proposta lida do banco mostra o valor em risco entre zero e o valor da nota', async () => {
    const { deps, call } = await captured();
    await proposeChecked(deps);
    const body = (await (await call(`/api/propostas/${NF080}`, DIRETORIA)).json()) as {
      amountAtRisk: { cents: number };
      total: { cents: number };
      line: number;
    };
    expect(body.amountAtRisk.cents).toBeGreaterThanOrEqual(0);
    expect(body.amountAtRisk.cents).toBeLessThanOrEqual(body.total.cents);
    expect(body.line).toBe(2);
  });
});

describe('#230 a auditoria na proposta (AC-7)', () => {
  const AUDIT_ROW = {
    status: 'audited', reason: null, classification: 'E5', dock_action: { kind: 'recusar' }, routing: 'diretoria',
    justification: 'a\nb', amount_at_risk_cents: null, model: 'm', audited_at: '2026-11-15T12:00:00+00:00',
    differing_fields: ['routing'], raised_level: 'diretoria', raised_from_level: 'coordenacao', injection_flag: null, refusals: [],
  };

  it('#230/AC-7: o detalhe traz a auditoria mais recente da nota; a anterior não auditada fica atrás', async () => {
    const { fake, deps, call } = await captured();
    await proposeChecked(deps);
    fake.tables.set('invoice_audits', [
      { id: 1, invoice_access_key: NF080, status: 'nao_auditada', reason: 'claude_falhou', refusals: [] },
      { id: 2, invoice_access_key: NF080, ...AUDIT_ROW },
    ]);
    const body = (await (await call(`/api/propostas/${NF080}`, DIRETORIA)).json()) as { audit: { status: string; raisedLevel: string } };
    expect(body.audit).toMatchObject({ status: 'auditada', raisedLevel: 'diretoria' });
    const withoutAudit = (await (await call(`/api/propostas/${NF036}`, DIRETORIA)).json()) as { audit: unknown };
    expect(withoutAudit.audit).toBeNull();
  });

  it('#230/AC-7: um erro ao ler a auditoria não derruba a proposta: audit nula e o log sem o texto do erro', async () => {
    const { fake, deps } = await captured();
    await proposeChecked(deps);
    const failing = new SupabaseRest({
      url: 'https://fake.supabase.co',
      secretKey: 'sb_secret_fake',
      fetch: async (input, init) =>
        input.includes('/invoice_audits') ? new Response('{"message":"segredo-do-banco-xyz"}', { status: 500 }) : fake.fetch(input, init),
    });
    const lines: string[] = [];
    const spy = console.error;
    console.error = (l: unknown) => void lines.push(String(l));
    try {
      const file = await new SupabaseApprovalStore(failing, () => NOW).find(NF080);
      expect(file?.proposal.level).toBe('diretoria');
      expect(file?.audit).toBeNull();
    } finally {
      console.error = spy;
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('segredo-do-banco-xyz');
  });
});
