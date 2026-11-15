// Testes online contra o Supabase real (#59). Pulam sem BARTE_ACADEMY_SUPABASE_URL e _SECRET_KEY.
// #59 Local: set -a; . ./.dev.vars; set +a; npm --prefix api test. Nenhum valor de chave é impresso.
import { afterAll, describe, expect, it } from 'vitest';
import { DockAction, Quantity } from '../../src/domain/index.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { arrayOf, isNumber, isString, nullable, optional, parseRows, shaped, type Shape } from '../../src/connectors/guards.js';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { kitCounts } from '../support/kit.js';

function env(name: string): string | undefined {
  const value: unknown = Reflect.get(process.env, name);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const URL_ = env('BARTE_ACADEMY_SUPABASE_URL');
const KEY = env('BARTE_ACADEMY_SUPABASE_SECRET_KEY');
const ONLINE = Boolean(URL_ && KEY);

// #59 As caixas de saída só gravam depois que a esteira aplicar 20261115140000_outbox_idempotency no merge.
async function outboxHasIdempotencyKey(): Promise<boolean> {
  if (!ONLINE) return false;
  const rest = new SupabaseRest({ url: URL_ ?? '', secretKey: KEY ?? '' });
  try {
    await rest.select('outbox_dock_actions', { select: 'idempotency_key', filters: { id: 'eq.0' } });
    return true;
  } catch (error) {
    if (error instanceof SupabaseRestError && /42703|PGRST/.test(error.detail)) return false;
    throw error;
  }
}
const HAS_IDEMPOTENCY = await outboxHasIdempotencyKey();

// #230 A subida de nível só existe depois que a esteira aplicar 20261116110000_invoice_audits no merge.
async function hasRaiseProposalLevel(): Promise<boolean> {
  if (!ONLINE) return false;
  const rest = new SupabaseRest({ url: URL_ ?? '', secretKey: KEY ?? '' });
  try {
    await rest.select('proposal_level_changes', { select: 'id', filters: { id: 'eq.0' } });
    await rest.rpc('raise_proposal_level', { p_invoice_access_key: 'sem-nota', p_to_level: 'analista', p_invoice_audit_id: 0 });
    return true;
  } catch (error) {
    if (error instanceof SupabaseRestError && /42P01|42883|PGRST/.test(`${error.code ?? ''} ${error.detail}`)) return false;
    throw error;
  }
}
const HAS_RAISE = await hasRaiseProposalLevel();

type LevelChangeRow = { proposal_id: number; from_level: string; to_level: string; invoice_audit_id: number };
const isLevelChangeRow = shaped<LevelChangeRow>({
  proposal_id: isNumber,
  from_level: isString,
  to_level: isString,
  invoice_audit_id: isNumber,
} satisfies Shape<LevelChangeRow>);
type IdRow = { id: number };
const isIdRow = shaped<IdRow>({ id: isNumber } satisfies Shape<IdRow>);
type LevelRow = { approval_level: string };
const isLevelRow = shaped<LevelRow>({ approval_level: isString } satisfies Shape<LevelRow>);

type ApiKey = { type?: string; name?: string | null; api_key: string };
const isApiKeys = arrayOf(
  shaped<ApiKey>({ type: optional(isString), name: optional(nullable(isString)), api_key: isString } satisfies Shape<ApiKey>),
);
type InvoiceStateRow = { access_key: string; state: string };
const isInvoiceStateRow = shaped<InvoiceStateRow>({ access_key: isString, state: isString } satisfies Shape<InvoiceStateRow>);

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
  const direct = env('BARTE_ACADEMY_SUPABASE_PUBLISHABLE_KEY');
  if (direct) return direct;
  const token = env('BARTE_ACADEMY_SUPABASE_ACCESS_TOKEN');
  const project = env('BARTE_ACADEMY_SUPABASE_PROJECT_ID');
  if (!token || !project) return undefined;
  const response = await fetch(`https://api.supabase.com/v1/projects/${project}/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const keys: unknown = await response.json();
  if (!isApiKeys(keys)) throw new Error('api-keys: resposta fora do formato esperado');
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

  it.skipIf(!HAS_IDEMPOTENCY)('#59/AC-4 cada caixa de saída grava e lê de volta, uma vez só por mensagem', async () => {
    const key = `teste-ac4-${Date.now()}`;
    const dock = await connectors.dockActions.publish({
      invoiceAccessKey: key,
      action: DockAction.partial([{ sku: 'SKU-1001', quantity: Quantity.of(2, 'CX'), disposition: 'segurar' }]),
    });
    written.push({ table: 'outbox_dock_actions', id: dock.id });
    const again = await connectors.dockActions.publish({
      invoiceAccessKey: key,
      action: DockAction.partial([{ sku: 'SKU-1001', quantity: Quantity.of(2, 'CX'), disposition: 'segurar' }]),
    });
    expect(again.id).toBe(dock.id);
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
    expect(second).toEqual({ seen: 80, inserted: 0, checked: 0, failed: 0 });
    const keys = parseRows(await rest.select('invoices', { select: 'access_key,state' }), isInvoiceStateRow, 'invoices');
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
      const parsed: unknown = response.ok ? await response.json() : [];
      const body: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      console.log(`  AC-6 ${table}: HTTP ${response.status}, ${body.length} linhas`);
      expect([200, 401, 403]).toContain(response.status);
      expect(body).toEqual([]);
    }
  });

  describe.skipIf(!HAS_RAISE)('#230 subida de nível da proposta', () => {
    const key = `teste-230-${Date.now()}`;

    afterAll(async () => {
      await rest.delete('invoices', { access_key: `eq.${key}` });
    });

    async function seed(): Promise<number> {
      await rest.insert('invoices', [
        {
          access_key: key, number: '1', series: '1', supplier_id: 'F-TESTE', store: 'L01', issued_on: '2026-11-10',
          entry_channel: 'edi', total_cents: 1000, items: [], state: 'com_proposta',
        },
      ]);
      await rest.insert('proposals', [
        {
          invoice_access_key: key, classification: 'E4', dock_action: { kind: 'receber' }, approval_level: 'analista',
          amount_at_risk_cents: 0, justification: 'teste online', state: 'aguardando_aprovacao',
        },
      ]);
      return audited();
    }

    async function audited(): Promise<number> {
      const rows = await rest.insert(
        'invoice_audits',
        [
          {
            invoice_access_key: key, status: 'audited', classification: 'E4', dock_action: { kind: 'receber' },
            routing: 'diretoria', justification: 'teste online', model: 'teste', audited_at: new Date().toISOString(),
            differing_fields: ['routing'], requested_level: 'diretoria', requested_from_level: 'analista',
          },
        ],
        { ignoreDuplicates: false },
      );
      return parseRows(rows, isIdRow, 'invoice_audits')[0]?.id ?? -1;
    }

    const raise = (level: string, auditId: number): Promise<unknown> =>
      rest.rpc('raise_proposal_level', { p_invoice_access_key: key, p_to_level: level, p_invoice_audit_id: auditId });
    const history = async (): Promise<LevelChangeRow[]> => {
      const proposal = parseRows(
        await rest.select('proposals', { select: 'id', filters: { invoice_access_key: `eq.${key}` } }),
        isIdRow,
        'proposals',
      )[0];
      return parseRows(
        await rest.select('proposal_level_changes', {
          select: 'proposal_id,from_level,to_level,invoice_audit_id',
          filters: { proposal_id: `eq.${proposal?.id ?? -1}` },
          order: 'id.asc',
        }),
        isLevelChangeRow,
        'proposal_level_changes',
      );
    };

    it('#230/AC-3 a função sobe o nível, grava uma linha de história e, repetida, devolve null sem outra linha', async () => {
      const auditId = await seed();
      expect(auditId).toBeGreaterThan(0);
      expect(await raise('diretoria', auditId)).toBe('diretoria');
      const level = parseRows(
        await rest.select('proposals', { select: 'approval_level', filters: { invoice_access_key: `eq.${key}` } }),
        isLevelRow,
        'proposals',
      );
      expect(level[0]?.approval_level).toBe('diretoria');
      const [first, ...rest1] = await history();
      expect(rest1).toEqual([]);
      expect(first).toMatchObject({ from_level: 'analista', to_level: 'diretoria', invoice_audit_id: auditId });
      expect(await raise('diretoria', auditId)).toBeNull();
      expect(await history()).toHaveLength(1);
      expect(await raise('bloqueio', auditId)).toBe('bloqueio');
      expect((await history()).map((h) => `${h.from_level}>${h.to_level}`)).toEqual([
        'analista>diretoria',
        'diretoria>bloqueio',
      ]);
    });

    it('#230/AC-1 uma segunda auditoria feita da mesma nota falha com 409 e código 23505', async () => {
      const error = await audited().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SupabaseRestError);
      expect(error).toMatchObject({ status: 409, code: '23505' });
    });

    it('#230/AC-3 a chave pública não chama a função (recusada), e a nota segue no nível aplicado', async () => {
      const pub = await publishableKey();
      if (!pub) return console.log('  #230 pulado: sem chave pública nem token para buscá-la');
      const headers: Record<string, string> = { apikey: pub, 'Content-Type': 'application/json' };
      if (!pub.startsWith('sb_')) headers.Authorization = `Bearer ${pub}`;
      const response = await fetch(`${(URL_ ?? '').replace(/\/+$/, '')}/rest/v1/rpc/raise_proposal_level`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p_invoice_access_key: key, p_to_level: 'bloqueio', p_invoice_audit_id: 0 }),
      });
      expect([401, 403, 404]).toContain(response.status);
      expect(await history()).toHaveLength(2);
    });
  });
});
