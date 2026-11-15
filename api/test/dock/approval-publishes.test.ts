import { describe, expect, it } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import { SupabaseApprovalStore } from '../../src/approval/supabase-store.js';
import type { DockActionOutbox } from '../../src/connectors/ports.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { wmsDockActionOutbox } from '../../src/connectors/wms-dock-action.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { publishDecidedDockActions } from '../../src/dock/publish-decided.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { kitInvoice } from '../approval/kit.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

// #43 AC-1: a aprovação da fila (#63) chega à doca (#72). A base do kit num PostgREST falso.

const NOW = new Date('2026-11-15T12:00:00Z');
const TODAY = '2026-11-15';
const DIRETORIA = 'diretoria@jachegou.test';
const env: Env = {
  ACCESS_AUD: 'aud',
  ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com',
  APPROVER_LEVELS: JSON.stringify({ [DIRETORIA]: 'diretoria' }),
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const verifier: AccessVerifier = { verify: async (token) => ({ ok: true, identity: { email: token } }) };

const NF080 = kitInvoice('NF-080'); // #63 F12, pagamento bloqueado: aguarda a diretoria
const NF036 = kitInvoice('NF-036'); // #63 dentro da tolerância: aprovada pela regra

type Row = { invoiceAccessKey: string; status: { kind: string; action?: { kind: string } } };

async function proposed(dockOutbox?: (rest: SupabaseRest) => DockActionOutbox) {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { captureDeps } = supabaseConnectors(rest);
  await captureInvoices(captureDeps);
  await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, now: () => NOW });
  const store = new SupabaseApprovalStore(rest, () => NOW);
  const outbox = dockOutbox ? dockOutbox(rest) : wmsDockActionOutbox(rest);
  const worker = createWorker({
    verifier,
    approval: { store, today: () => TODAY, dockOutbox: outbox },
    dock: { supabase: () => rest, today: () => TODAY },
  });
  const call = (path: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request(`https://worker.test${path}`, { ...init, headers: { 'Cf-Access-Jwt-Assertion': DIRETORIA, ...init.headers } }),
      env,
      ctx,
    );
  const dockRow = async (invoice: { accessKey: string; store: string; issuedOn: string }): Promise<Row> => {
    const res = await call(`/api/doca?destino=${invoice.store}&data=${invoice.issuedOn}`);
    const body = (await res.json()) as { rows: Row[] };
    const row = body.rows.find((r) => r.invoiceAccessKey === invoice.accessKey);
    if (!row) throw new Error(`nota ${invoice.accessKey} fora da doca`);
    return row;
  };
  return { fake, rest, call, dockRow };
}

describe('#43 AC-1 aprovar na fila publica a ação na doca', () => {
  it('#43/AC-1 aprovar uma proposta do kit tira a nota de aguardando e mostra a ação na /api/doca', async () => {
    const { call, dockRow } = await proposed();
    expect((await dockRow(NF080)).status.kind).toBe('aguardando_aprovacao');

    expect((await call(`/api/propostas/${NF080.accessKey}/aprovar`, { method: 'POST' })).status).toBe(200);

    const row = await dockRow(NF080);
    expect(row.status.kind).toBe('acao');
    expect(row.status.action?.kind).toMatch(/^(receber|receber_parcial|recusar)$/);
  });

  it('#43/AC-1 regra 8: alterar publica a ação nova, com a justificativa', async () => {
    const { call, dockRow } = await proposed();
    const res = await call(`/api/propostas/${NF080.accessKey}/alterar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dockAction: { kind: 'recusar' }, justification: 'Fornecedor bloqueado: não descarrega' }),
    });
    expect(res.status).toBe(200);
    expect((await dockRow(NF080)).status).toMatchObject({ kind: 'acao', action: { kind: 'recusar' } });
  });

  it('#43/AC-1 a decisão gravada vale mesmo se o WMS falhar; a varredura publica depois', async () => {
    const failing: DockActionOutbox = {
      publish: async () => {
        throw new Error('WMS fora');
      },
      list: async () => [],
    };
    const { fake, rest, call, dockRow } = await proposed(() => failing);
    expect((await call(`/api/propostas/${NF080.accessKey}/aprovar`, { method: 'POST' })).status).toBe(200);
    expect(fake.rows('outbox_dock_actions').some((r) => r.invoice_access_key === NF080.accessKey)).toBe(false);

    await publishDecidedDockActions(rest);
    expect((await dockRow(NF080)).status.kind).toBe('acao');
  });
});

describe('#43 AC-1 o que a regra aprova sem pessoa também chega à doca', () => {
  it('#43/AC-1 a varredura publica a proposta aprovada pela regra', async () => {
    const { rest, dockRow } = await proposed();
    expect((await dockRow(NF036)).status.kind).toBe('aguardando_aprovacao');

    const first = await publishDecidedDockActions(rest);
    expect(first.published).toBeGreaterThan(0);
    expect((await dockRow(NF036)).status.kind).toBe('acao');
  });

  it('#43/AC-1 a varredura é idempotente: a segunda rodada não publica nada', async () => {
    const { fake, rest } = await proposed();
    await publishDecidedDockActions(rest);
    const rows = fake.rows('outbox_dock_actions').length;
    expect(await publishDecidedDockActions(rest)).toEqual({ published: 0 });
    expect(fake.rows('outbox_dock_actions')).toHaveLength(rows);
  });

  it('#43/AC-3 a varredura não publica proposta sem decisão', async () => {
    const { fake, rest } = await proposed();
    await publishDecidedDockActions(rest);
    const published = new Set(fake.rows('outbox_dock_actions').map((r) => r.invoice_access_key));
    expect(published.has(NF080.accessKey)).toBe(false);
  });
});
