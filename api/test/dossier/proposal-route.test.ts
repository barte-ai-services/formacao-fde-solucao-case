import { describe, expect, it } from 'vitest';
import { MemoryApprovalStore, type CaseFile } from '../../src/approval/store.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { draftProposal, propose } from '../../src/domain/approval.js';
import { ApprovalPolicy } from '../../src/domain/approval-policy.js';
import { Title, type Invoice } from '../../src/domain/index.js';
import { SupabaseDossierSource } from '../../src/dossier/source.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { checkedWith, kitInvoice } from '../approval/kit.js';
import { emptyContext } from '../domain/fixtures.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

// #68: o dossiê no GET /api/propostas/:chave da #63, lido de claude_suggestions.

const TODAY = '2026-11-15';
const ANALISTA = 'analista@jachegou.test';
const env: Env = {
  ACCESS_AUD: 'aud',
  ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com',
  APPROVER_LEVELS: JSON.stringify({ [ANALISTA]: 'analista' }),
};
// #68: o handler do Worker exige um ExecutionContext; a rota não usa nenhum campo dele.
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const verifier: AccessVerifier = {
  async verify(token) {
    return { ok: true, identity: { email: token } };
  },
};

function caseFile(invoice: Invoice): CaseFile {
  const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: '2026-12-10' });
  const route = ApprovalPolicy.route(invoice);
  const { proposal, approval } = propose(invoice, title, { route, ...draftProposal(invoice, null), today: TODAY });
  return { invoice, proposal, title, route, approval, supplierBlocked: false };
}

async function detail(suggestions: Record<string, unknown>[]) {
  const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
  const fake = new FakePostgrest({ claude_suggestions: suggestions });
  const source = new SupabaseDossierSource(
    new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch }),
  );
  const worker = createWorker({
    verifier,
    approval: {
      store: new MemoryApprovalStore([caseFile(invoice)]),
      today: () => TODAY,
      dossier: { source, context: async () => emptyContext() },
    },
  });
  const res = await worker.fetch(
    new Request(`https://worker.test/api/propostas/${invoice.accessKey}`, { headers: { 'Cf-Access-Jwt-Assertion': ANALISTA } }),
    env,
    ctx,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { dossier: Record<string, unknown> };
  return { invoice, dossier: body.dossier };
}

describe('GET /api/propostas/:chave com o dossiê', () => {
  it('#38/AC-4 sem linha em claude_suggestions, o dossiê vem unavailable/pending com o aviso', async () => {
    const { dossier } = await detail([]);
    expect(dossier).toEqual({
      status: 'unavailable',
      reason: 'pending',
      notice: expect.stringContaining('o dossiê ainda não foi gerado'),
      generatedAt: null,
    });
  });

  it('#38/AC-1 com a sugestão ok, o dossiê vem ready, renderizado com os valores do banco', async () => {
    const invoice = checkedWith(kitInvoice('NF-008'), 'E4');
    const code = invoice.items[0]!.supplierCode;
    const output = {
      summary: `A nota cobra {{nota.item[${code}].quantidade}} do item ${code}.`,
      divergences: [
        { classification: 'E4', what_diverges: 'Unidade diferente da ordem.', evidence: [`nota.item[${code}].quantidade`] },
      ],
      supplier_history: 'Sem histórico.',
    };
    const { dossier } = await detail([
      {
        task: 'dossier',
        input_key: invoice.accessKey,
        input: {},
        output,
        status: 'ok',
        model: 'claude-opus-5-5',
        error: null,
        generated_at: '2026-11-15T12:00:00.000Z',
      },
    ]);
    const item = invoice.items[0]!;
    expect(dossier).toMatchObject({
      status: 'ready',
      summary: `A nota cobra ${item.quantity.amount} ${item.quantity.unit} do item ${code}.`,
      model: 'claude-opus-5-5',
    });
  });
});
