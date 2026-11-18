import { proposeChecked } from '../../src/approval/propose-checked.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { dockActionToJson } from '../../src/approval/supabase-store.js';
import { DockAction, Quantity } from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

// #156 Apoio dos testes do adaptador: o kit capturado e proposto pelo Cron, sobre o PostgREST falso.

export type Row = Record<string, unknown>;
const NOW = new Date('2026-11-15T12:00:00Z');

export type ProposedWorld = { readonly fake: FakePostgrest; readonly rest: SupabaseRest };

export async function proposedWorld(): Promise<ProposedWorld> {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { captureDeps } = supabaseConnectors(rest);
  await captureInvoices(captureDeps);
  await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, now: () => NOW });
  return { fake, rest };
}

/** #156 A primeira proposta da classificação dada, ainda aguardando aprovação. */
export function awaiting(fake: FakePostgrest, classification: string, nth = 0): Row {
  const found = fake.rows('proposals').filter((p) => p.classification === classification && p.state === 'aguardando_aprovacao')[nth];
  if (!found) throw new Error(`sem proposta ${classification} aguardando`);
  return found;
}

/** #156 A pessoa decide: a proposta ganha o estado e a ação, e a aprovação entra com o dia da decisão. */
export function decide(
  fake: FakePostgrest,
  proposal: Row,
  decision: { state: 'aprovada' | 'alterada'; action: DockAction; decidedOn: string | null },
): void {
  proposal.state = decision.state;
  proposal.dock_action = dockActionToJson(decision.action);
  fake.rows('approvals').push({
    id: 1000 + Number(proposal.id),
    proposal_id: proposal.id,
    approver: 'coordenacao@jachegou.test',
    approver_level: 'coordenacao',
    justification: null,
    dock_action: dockActionToJson(decision.action),
    decided_on: decision.decidedOn,
    approved_at: '2026-11-13T15:00:00.000Z',
  });
}

/** #156 A ação parcial que devolve 1 do primeiro item da nota da proposta, na unidade do item. */
export function returnFirstItem(fake: FakePostgrest, proposal: Row): DockAction {
  const invoice = fake.rows('invoices').find((i) => i.access_key === proposal.invoice_access_key);
  const [item] = (invoice?.items ?? []) as { sku: string | null; supplierCode: string; quantity: { unit: 'UN' | 'CX' } }[];
  if (!item) throw new Error('nota sem item');
  return DockAction.partial([{ sku: item.sku ?? item.supplierCode, quantity: Quantity.of(1, item.quantity.unit), disposition: 'devolver' }]);
}
