import { SupabaseApprovalStore } from '../../src/approval/supabase-store.js';
import { erpReturnNoteOutbox } from '../../src/connectors/erp-return-note.js';
import type { DockActionOutbox, ReturnNoteOutbox } from '../../src/connectors/ports.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import type { Invoice } from '../../src/domain/index.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { appStoreActionOutbox } from '../../src/connectors/store-action.js';
import { wmsDockActionOutbox } from '../../src/connectors/wms-dock-action.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { proposedWorld, type Row } from './supabase-decided-source.support.js';

// #9 Apoio da aceitação da #1: a rota de decisão montada sobre o kit e o PostgREST falso.

export const TODAY = '2026-11-15';
export const DIRETORIA = 'diretoria@jachegou.test';
const NOW = new Date('2026-11-15T12:00:00Z');
const ENV: Env = {
  ACCESS_AUD: 'aud',
  ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com',
  APPROVER_LEVELS: JSON.stringify({ [DIRETORIA]: 'diretoria' }),
};
// #9 O mesmo contexto mínimo dos outros testes do Worker: a rota não usa nada dele.
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const verifier: AccessVerifier = { verify: async (token) => ({ ok: true, identity: { email: token } }) };

export type QueueNote = { id: number; invoiceAccessKey: string; status: string; valueCents: number | null; lines: { supplierCode: string; quantity: { amount: number; unit: string }; valueCents: number | null }[] };

export type Assembled = {
  readonly fake: FakePostgrest;
  readonly rest: SupabaseRest;
  readonly call: (path: string, init?: RequestInit) => Promise<Response>;
  readonly approve: (key: string) => Promise<Response>;
  readonly alter: (key: string, dockAction: unknown) => Promise<Response>;
  readonly queue: () => Promise<QueueNote[]>;
};

/** #9 O kit capturado e proposto, e o Worker com a rota de aprovação e a fila de devoluções ligadas. */
export async function assembled(over: { returnOutbox?: (rest: SupabaseRest) => ReturnNoteOutbox; dockOutbox?: (rest: SupabaseRest) => DockActionOutbox } = {}): Promise<Assembled> {
  const { fake, rest } = await proposedWorld();
  const { captureDeps } = supabaseConnectors(rest);
  const worker = createWorker({
    verifier,
    approval: {
      store: new SupabaseApprovalStore(rest, () => NOW),
      today: () => TODAY,
      dockOutbox: (over.dockOutbox ?? wmsDockActionOutbox)(rest),
      storeOutbox: appStoreActionOutbox(rest),
      returnOutbox: (over.returnOutbox ?? erpReturnNoteOutbox)(rest),
      products: () => captureDeps.registry.listProducts(),
      receipts: () => captureDeps.wms.listReceipts(),
    },
    returnNotes: { supabase: () => rest, now: () => NOW },
  });
  const call = (path: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request(`https://worker.test${path}`, { ...init, headers: { 'Cf-Access-Jwt-Assertion': DIRETORIA, 'content-type': 'application/json', ...init.headers } }),
      ENV,
      ctx,
    );
  const approve = (key: string) => call(`/api/propostas/${key}/aprovar`, { method: 'POST' });
  const alter = (key: string, dockAction: unknown) =>
    call(`/api/propostas/${key}/alterar`, { method: 'POST', body: JSON.stringify({ dockAction, justification: 'Decisão da aceitação' }) });
  const queue = async (): Promise<QueueNote[]> => ((await (await call('/api/return-notes')).json()) as { notes: QueueNote[] }).notes;
  return { fake, rest, call, approve, alter, queue };
}

export const keyOf = (proposal: Row): string => String(proposal.invoice_access_key);

/** #9 A nota da proposta, como o domínio a lê do banco. */
export async function invoiceOf(rest: SupabaseRest, proposal: Row): Promise<Invoice> {
  const file = await new SupabaseApprovalStore(rest, () => NOW).find(keyOf(proposal));
  if (!file) throw new Error('proposta sem nota');
  return file.invoice;
}

/** #9 Um recebimento da nota na base do kit (kit_recebimentos e seus itens). */
export function addReceipt(fake: FakePostgrest, accessKey: string, day: string, items: readonly (readonly [string, number, 'UN' | 'CX'])[], id = 'RC-ACEITE-1'): void {
  fake.rows('kit_recebimentos').push({
    recebimento_id: id, nota_chave: accessKey, ordem_id: 'OC-ACEITE', fornecedor_id: 'F01', destino: 'LJ-001', canal: 'app_loja', data: day, observacao: '',
  });
  for (const [codigo, quantidade, unidade] of items) {
    fake.rows('kit_recebimento_itens').push({ recebimento_id: id, codigo_fornecedor: codigo, descricao: codigo, quantidade, unidade });
  }
}

/** #9 Tira do kit os recebimentos da nota (as notas E1, E2 e E3 do kit já têm o seu), para o cenário dar o que quer. */
export function clearReceipts(fake: FakePostgrest, accessKey: string): void {
  const ids = new Set(fake.rows('kit_recebimentos').filter((r) => r.nota_chave === accessKey).map((r) => r.recebimento_id));
  const keep = (table: string, field: string): void => {
    const rows = fake.tables.get(table) ?? [];
    fake.tables.set(table, rows.filter((r) => !ids.has(r[field])));
  };
  keep('kit_recebimentos', 'recebimento_id');
  keep('kit_recebimento_itens', 'recebimento_id');
}
