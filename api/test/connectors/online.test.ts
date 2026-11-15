// Testes online contra o Supabase real (#59). Pulam sem BARTE_ACADEMY_SUPABASE_URL e _SECRET_KEY.
// #59 Local: set -a; . ./.dev.vars; set +a; npm --prefix api test. Nenhum valor de chave é impresso.
import { afterAll, describe, expect, it } from 'vitest';
import { DockAction, Quantity } from '../../src/domain/index.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { kitCounts } from '../support/kit.js';

const URL_ = process.env.BARTE_ACADEMY_SUPABASE_URL as string | undefined;
const KEY = process.env.BARTE_ACADEMY_SUPABASE_SECRET_KEY as string | undefined;
const ONLINE = Boolean(URL_ && KEY);

const DOMAIN_TABLES = [
  'invoices',
  'divergences',
  'proposals',
  'approvals',
  'titles',
  'outbox_dock_actions',
  'outbox_registry_corrections',
  'outbox_return_notes',
];

async function publishableKey(): Promise<string | undefined> {
  const direct = process.env.BARTE_ACADEMY_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  if (direct) return direct;
  const token = process.env.BARTE_ACADEMY_SUPABASE_ACCESS_TOKEN as string | undefined;
  const project = process.env.BARTE_ACADEMY_SUPABASE_PROJECT_ID as string | undefined;
  if (!token || !project) return undefined;
  const response = await fetch(`https://api.supabase.com/v1/projects/${project}/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const keys = (await response.json()) as { type?: string; name?: string; api_key: string }[];
  return (keys.find((k) => k.type === 'publishable') ?? keys.find((k) => k.type === 'legacy' && k.name === 'anon'))?.api_key;
}

describe.skipIf(!ONLINE)('#59 online, no Supabase real', () => {
  const rest = new SupabaseRest({ url: URL_ ?? '', secretKey: KEY ?? '' });
  const connectors = supabaseConnectors(rest);
  const written: { table: string; id: number }[] = [];
  const counts = kitCounts();

  afterAll(async () => {
    for (const { table, id } of written) await rest.delete(table, { id: `eq.${id}` });
  });

  it('#59/AC-3 cada conector confere a contagem com o JSON do kit', async () => {
    const d = connectors.captureDeps;
    const invoices = await d.sefaz.listIssuedInvoices();
    const orders = await d.purchasing.listPurchaseOrders();
    const receipts = await d.wms.listReceipts();
    const found = {
      kit_notas: invoices.length,
      kit_nota_itens: invoices.flatMap((i) => i.items).length,
      kit_ordens: orders.length,
      kit_ordem_itens: orders.flatMap((o) => o.items).length,
      kit_notas_lancadas: (await d.payables.listPostedInvoices()).length,
      kit_fornecedores: (await d.registry.listSuppliers()).length,
      kit_produtos: (await d.registry.listProducts()).length,
      kit_pagamentos: (await d.bank.listPayments()).length,
      kit_recebimentos: receipts.length,
      kit_recebimento_itens: receipts.flatMap((r) => r.items).length,
    };
    console.log(`  AC-3 online: ${JSON.stringify(found)}`);
    for (const [table, n] of Object.entries(found)) expect(n, table).toBe(counts[table]);
  });

  it('#59/AC-4 cada caixa de saída grava e lê de volta', async () => {
    const key = `teste-ac4-${Date.now()}`;
    const dock = await connectors.dockActions.publish({
      invoiceAccessKey: key,
      action: DockAction.partial([{ sku: 'SKU-1001', quantity: Quantity.of(2, 'CX'), disposition: 'segurar' }]),
    });
    written.push({ table: 'outbox_dock_actions', id: dock.id });
    const correction = await connectors.registryCorrections.publish({
      invoiceAccessKey: key, kind: 'E4_fator_de_caixa', supplierCode: 'F01-001', sku: 'SKU-1001', detail: 'fator 12',
    });
    written.push({ table: 'outbox_registry_corrections', id: correction.id });
    const note = await connectors.returnNotes.publish({
      invoiceAccessKey: key, lines: [{ supplierCode: 'F01-001', quantity: Quantity.of(4, 'UN') }], reason: 'avaria',
    });
    written.push({ table: 'outbox_return_notes', id: note.id });

    const dockBack = (await connectors.dockActions.list()).find((m) => m.id === dock.id);
    expect(dockBack?.action.kind).toBe('receber_parcial');
    expect((await connectors.registryCorrections.list()).find((m) => m.id === correction.id)?.detail).toBe('fator 12');
    const noteBack = (await connectors.returnNotes.list()).find((m) => m.id === note.id);
    expect(noteBack?.lines[0]?.quantity.equals(Quantity.of(4, 'UN'))).toBe(true);
  });

  it('#59/AC-5 regra 1: capturar duas vezes deixa 80 chaves distintas em invoices', async () => {
    const first = await captureInvoices(connectors.captureDeps);
    const second = await captureInvoices(connectors.captureDeps);
    console.log(`  AC-5 online: 1ª ${JSON.stringify(first)} 2ª ${JSON.stringify(second)}`);
    expect(second).toEqual({ seen: 80, inserted: 0, checked: 0 });
    const keys = await rest.select<{ access_key: string; state: string }>('invoices', { select: 'access_key,state' });
    expect(keys).toHaveLength(80);
    expect(new Set(keys.map((k) => k.access_key)).size).toBe(80);
    expect(keys.every((k) => k.state !== 'a_conferir')).toBe(true);
  }, 60_000);

  it('#59/AC-6 a chave pública lê zero linhas (ou erro) em cada tabela do domínio', async () => {
    const pub = await publishableKey();
    if (!pub) return console.log('  AC-6 pulado: sem chave pública nem token para buscá-la');
    expect((await rest.select('invoices', { select: 'access_key' })).length).toBeGreaterThan(0);
    for (const table of DOMAIN_TABLES) {
      const headers: Record<string, string> = { apikey: pub };
      if (!pub.startsWith('sb_')) headers.Authorization = `Bearer ${pub}`;
      const response = await fetch(`${(URL_ ?? '').replace(/\/+$/, '')}/rest/v1/${table}?select=*`, { headers });
      const body = response.ok ? ((await response.json()) as unknown[]) : [];
      console.log(`  AC-6 ${table}: HTTP ${response.status}, ${body.length} linhas`);
      expect([200, 401, 403]).toContain(response.status);
      expect(body).toEqual([]);
    }
  });
});
