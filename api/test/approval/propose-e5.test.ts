import { describe, expect, it } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import type { ProbableOrderSuggestions } from '../../src/connectors/probable-order-suggestions.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import type { ProbableOrderSuggestion } from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { kitInvoice } from './kit.js';

// #65 A proposta da nota sem ordem (E5) no fluxo da #63, sobre a base do kit num PostgREST falso.

const NOW = new Date('2026-11-15T12:00:00Z');
const NF035 = kitInvoice('NF-035').accessKey; // #65 F10, LJ-030, sem pedido; a OC-2026-41914 tem os mesmos itens
const NF002 = kitInvoice('NF-002').accessKey; // #65 F05, LJ-026, sem pedido; nenhuma ordem cobre os itens

const fixed = (entries: [string, ProbableOrderSuggestion][]): ProbableOrderSuggestions => ({
  listSuggestions: async (keys) => new Map(entries.filter(([k]) => keys.includes(k))),
});

async function proposed(suggestions?: ProbableOrderSuggestions) {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { captureDeps } = supabaseConnectors(rest);
  await captureInvoices(captureDeps);
  await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, suggestions, now: () => NOW });
  const row = (key: string) => fake.rows('proposals').find((r) => r.invoice_access_key === key);
  return { row };
}

describe('#65 proposta da nota sem ordem (E5)', () => {
  it('#34/AC-2, AC-4: sem sugestão, a regra sozinha acha a única ordem confirmada (NF-035), e a régua manda à coordenação', async () => {
    const { row } = await proposed();
    const nf035 = row(NF035);
    expect(nf035).toMatchObject({ classification: 'E5', approval_level: 'coordenacao', dock_action: { kind: 'recusar' } });
    expect(nf035?.justification).toContain('OC-2026-41914');
    expect(nf035?.justification).toContain('a regra a achou sozinha');
  });

  it('#34/AC-3: sem ordem que a regra confirme, a proposta diz que não há ordem e não cita nenhuma (NF-002)', async () => {
    const { row } = await proposed();
    const nf002 = row(NF002);
    expect(nf002).toMatchObject({ classification: 'E5', approval_level: 'coordenacao' });
    expect(nf002?.justification).toContain('Não há ordem de compra confirmada');
    expect(nf002?.justification).not.toMatch(/OC-/);
  });

  it('#34/AC-2: a sugestão do Claude que a regra confirma entra rotulada', async () => {
    const { row } = await proposed(fixed([[NF035, { orderId: 'OC-2026-41914', reason: 'mesmos itens e destino' }]]));
    expect(row(NF035)?.justification).toContain('Sugestão do Claude: mesmos itens e destino');
  });

  it('#34/AC-3: a sugestão do Claude que a regra recusa não aparece (ordem de outro destino na NF-002)', async () => {
    const { row } = await proposed(fixed([[NF002, { orderId: 'OC-2026-42615', reason: 'parece' }]]));
    expect(row(NF002)?.justification).not.toMatch(/OC-/);
  });
});
