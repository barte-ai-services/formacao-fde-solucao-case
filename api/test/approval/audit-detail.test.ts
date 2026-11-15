/** #230/AC-7 A API que devolve a proposta devolve também a auditoria, em cada um dos três estados. */
import { describe, expect, it } from 'vitest';
import { MemoryApprovalStore, type CaseFile, type StoredAudit } from '../../src/approval/store.js';
import { draftProposal, propose } from '../../src/domain/approval.js';
import { ApprovalPolicy } from '../../src/domain/approval-policy.js';
import { Title } from '../../src/domain/index.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { checkedWith, kitInvoice, kitSupplier } from './kit.js';

const ANALISTA = 'analista@jachegou.test';
const env: Env = { ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com', APPROVER_LEVELS: JSON.stringify({ [ANALISTA]: 'analista' }) };
// #230 stub de teste: o Worker só usa waitUntil/passThroughOnException
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const verifier: AccessVerifier = { verify: async (token) => ({ ok: true, identity: { email: token } }) };

function file(audit?: StoredAudit | null): CaseFile {
  const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
  const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: '2026-12-10' });
  const route = ApprovalPolicy.route(invoice, kitSupplier(invoice.supplierId));
  const { proposal, approval } = propose(invoice, title, { route, ...draftProposal(invoice, null), today: '2026-11-15' });
  return { invoice, proposal, title, route, approval, supplierBlocked: false, ...(audit === undefined ? {} : { audit }) };
}

async function detail(f: CaseFile): Promise<Record<string, unknown>> {
  const worker = createWorker({ verifier, approval: { store: new MemoryApprovalStore([f]), today: () => '2026-11-15' } });
  const res = await worker.fetch(
    new Request(`https://worker.test/api/propostas/${f.invoice.accessKey}`, { headers: { 'Cf-Access-Jwt-Assertion': ANALISTA } }),
    env,
    ctx,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const AUDITED: StoredAudit = {
  status: 'auditada', classification: 'E2', dockAction: 'recusar', routing: 'coordenacao', justification: 'a\nb',
  amountAtRiskCents: 60000, model: 'claude-teste', auditedAt: '2026-11-15T18:30:00.000Z', differs: ['classification', 'dock_action', 'routing'],
  raisedLevel: 'coordenacao', injectionFlag: 'ignore a régua', refusals: [{ refusal: 'routing_below_regua', minimumLevel: 'analista' }],
};

describe('GET /api/propostas/:chave: a auditoria (#230)', () => {
  it('#230/AC-7: ainda não auditada: audit é null', async () => {
    expect((await detail(file(null))).audit).toBeNull();
    expect((await detail(file())).audit).toBeNull();
  });

  it('#230/AC-7: não auditada: o motivo e as recusas, e o resto da proposta segue igual', async () => {
    const body = await detail(file({ status: 'nao_auditada', reason: 'erro_de_tool', refusals: [] }));
    expect(body.audit).toEqual({ status: 'nao_auditada', reason: 'erro_de_tool', refusals: [] });
    expect(body.justification).toBeTypeOf('string');
  });

  it('#230/AC-7: auditada: a auditoria, a discordância, o nível elevado, o injection_flag e as recusas', async () => {
    const body = await detail(file(AUDITED));
    expect(body.audit).toEqual({
      status: 'auditada',
      classification: 'E2',
      dockAction: { kind: 'recusar' },
      routing: 'coordenacao',
      justification: 'a\nb',
      amountAtRisk: { cents: 60000, text: expect.any(String) },
      model: 'claude-teste',
      auditedAt: '2026-11-15T18:30:00.000Z',
      // #230 Na resposta, as chaves seguem o camelCase do resto (dock_action vira dockAction); no banco e no domínio ficam em snake_case.
      agreement: { agrees: false, differs: ['classification', 'dockAction', 'routing'] },
      raisedLevel: 'coordenacao',
      injectionFlag: 'ignore a régua',
      refusals: [{ refusal: 'routing_below_regua', minimumLevel: 'analista' }],
    });
  });

  it('#230/AC-7: concordando, agreement é agrees true; sem valor em risco nem nível elevado, vão nulos', async () => {
    const body = await detail(file({ ...AUDITED, differs: [], amountAtRiskCents: null, raisedLevel: null, injectionFlag: null, refusals: [] }));
    expect(body.audit).toMatchObject({ agreement: { agrees: true }, amountAtRisk: null, raisedLevel: null, injectionFlag: null, refusals: [] });
  });
});
