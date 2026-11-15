import { describe, expect, it } from 'vitest';
import { DockAction, Quantity } from '../../src/domain/index.js';
import { deriveBalances } from '../../src/connectors/erp-purchasing.js';
import type { KitNotaLancada, KitNotaLancadaItem, KitOrdemItem, KitProduto } from '../../src/connectors/kit-rows.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { idempotencyKey } from '../../src/connectors/outbox.js';
import { SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitCounts, kitTables } from '../support/kit.js';

function offline() {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  return { fake, ...supabaseConnectors(rest) };
}

describe('#59/AC-3 cada conector devolve a contagem do JSON do kit (offline)', () => {
  const counts = kitCounts();

  it('SEFAZ: 80 notas a conferir, com os 218 itens', async () => {
    const invoices = await offline().captureDeps.sefaz.listIssuedInvoices();
    expect(invoices).toHaveLength(counts.kit_notas!);
    expect(invoices.flatMap((i) => i.items)).toHaveLength(counts.kit_nota_itens!);
    expect(invoices.every((i) => i.state === 'a_conferir')).toBe(true);
  });

  it('ERP Compras: 102 ordens e 288 itens, cada um com saldo', async () => {
    const orders = await offline().captureDeps.purchasing.listPurchaseOrders();
    expect(orders).toHaveLength(counts.kit_ordens!);
    expect(orders.flatMap((o) => o.items)).toHaveLength(counts.kit_ordem_itens!);
  });

  it('ERP Contas a pagar: 34 notas lançadas', async () => {
    expect(await offline().captureDeps.payables.listPostedInvoices()).toHaveLength(counts.kit_notas_lancadas!);
  });

  it('ERP Cadastro: 12 fornecedores e 37 produtos', async () => {
    const { registry } = offline().captureDeps;
    expect(await registry.listSuppliers()).toHaveLength(counts.kit_fornecedores!);
    expect(await registry.listProducts()).toHaveLength(counts.kit_produtos!);
  });

  it('Banco: 9 pagamentos', async () => {
    expect(await offline().captureDeps.bank.listPayments()).toHaveLength(counts.kit_pagamentos!);
  });

  it('WMS: 71 recebimentos e 183 itens contados', async () => {
    const receipts = await offline().captureDeps.wms.listReceipts();
    expect(receipts).toHaveLength(counts.kit_recebimentos!);
    expect(receipts.flatMap((r) => r.items)).toHaveLength(counts.kit_recebimento_itens!);
  });

  it('dinheiro vira centavos inteiros (8,49 → 849)', async () => {
    const invoices = await offline().captureDeps.sefaz.listIssuedInvoices();
    const first = invoices.find((i) => i.accessKey === '35261174055489000148550010000438941174512643');
    const item = first?.items.find((i) => i.supplierCode === 'F02-002');
    expect(item?.unitPrice.cents).toBe(849);
    expect(first?.total.cents).toBe(141856);
  });
});

describe('#59 regra 5: saldo da ordem derivado das notas lançadas', () => {
  it('no kit: ordem já cobrada por nota lançada fica com saldo zero; ordem não cobrada guarda a quantidade', async () => {
    const orders = await offline().captureDeps.purchasing.listPurchaseOrders();
    const charged = orders.find((o) => o.id === 'OC-2026-42809')?.items.find((i) => i.supplierCode === 'F06-002');
    const untouched = orders.find((o) => o.id === 'OC-2026-41914')?.items.find((i) => i.supplierCode === 'F10-001');
    expect(charged?.balance.equals(Quantity.of(0, 'UN'))).toBe(true);
    expect(untouched?.balance.equals(Quantity.of(280, 'UN'))).toBe(true);
  });

  it('cobrança parcial abate o saldo, caixa vira unidade pelo fator e o saldo nunca fica negativo', () => {
    const item = (ordem_id: string, codigo_fornecedor: string, quantidade: number): KitOrdemItem => ({
      ordem_id, codigo_fornecedor, sku: null, descricao: '', quantidade, unidade: 'UN', preco_unitario: 1,
    });
    const posted = (chave: string, pedido_referenciado: string) => ({ chave, pedido_referenciado }) as KitNotaLancada;
    const line = (chave: string, codigo_fornecedor: string, quantidade: number, unidade: string) =>
      ({ chave, codigo_fornecedor, quantidade, unidade }) as KitNotaLancadaItem;
    const balances = deriveBalances({
      orderItems: [item('OC-1', 'A', 100), item('OC-1', 'B', 48), item('OC-2', 'A', 10)],
      postedInvoices: [posted('N1', 'OC-1'), posted('N2', 'OC-2')],
      postedItems: [line('N1', 'A', 30, 'UN'), line('N1', 'B', 2, 'CX'), line('N2', 'A', 15, 'UN')],
      products: [{ codigo_fornecedor: 'B', fator_caixa: 12 } as KitProduto],
    });
    expect(balances.get('OC-1|A')?.amount).toBe(70);
    expect(balances.get('OC-1|B')?.amount).toBe(24);
    expect(balances.get('OC-2|A')?.amount).toBe(0);
  });
});

describe('#59/AC-4 cada caixa de saída grava e lê de volta (offline)', () => {
  it('ação na doca, inclusive o receber parcial com quantidade', async () => {
    const { dockActions, fake } = offline();
    const action = DockAction.partial([{ sku: 'SKU-1', quantity: Quantity.of(3, 'CX'), disposition: 'devolver' }]);
    const published = await dockActions.publish({ invoiceAccessKey: 'K1', action });
    await dockActions.publish({ invoiceAccessKey: 'K2', action: DockAction.refuse() });
    const listed = await dockActions.list();
    expect(fake.rows('outbox_dock_actions')).toHaveLength(2);
    expect(listed.map((m) => m.action.kind)).toEqual(['receber_parcial', 'recusar']);
    expect(listed[0]).toMatchObject({ id: published.id, invoiceAccessKey: 'K1' });
    const back = listed[0]?.action;
    expect(back?.kind === 'receber_parcial' && back.lines[0]?.quantity.equals(Quantity.of(3, 'CX'))).toBe(true);
  });

  it('correção de cadastro (E8 e E4)', async () => {
    const { registryCorrections } = offline();
    const message = { invoiceAccessKey: 'K1', kind: 'E8_item_sem_cadastro' as const, supplierCode: 'F02-009', sku: null, detail: 'sem SKU' };
    await registryCorrections.publish(message);
    expect(await registryCorrections.list()).toMatchObject([message]);
  });

  it('nota de devolução', async () => {
    const { returnNotes } = offline();
    await returnNotes.publish({ invoiceAccessKey: 'K1', lines: [{ supplierCode: 'A', quantity: Quantity.of(5, 'UN') }], reason: 'avaria' });
    const [back] = await returnNotes.list();
    expect(back?.reason).toBe('avaria');
    expect(back?.lines[0]?.quantity.equals(Quantity.of(5, 'UN'))).toBe(true);
  });
});

describe('#59 validação na borda: linha malformada vira erro com a tabela e o índice, nunca os dados', () => {
  it('kit_notas com valor_total que não é número', async () => {
    const tables = kitTables();
    const notas = tables.kit_notas ?? [];
    tables.kit_notas = notas.map((n, i) => (i === 3 ? { ...n, valor_total: 'segredo-nao-numerico' } : n));
    const fake = new FakePostgrest(tables);
    const { captureDeps } = supabaseConnectors(new SupabaseRest({ url: 'https://f', secretKey: 'sb_secret_fake', fetch: fake.fetch }));
    const error = await captureDeps.sefaz.listIssuedInvoices().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseRestError);
    expect(error).toMatchObject({ operation: 'parse', table: 'kit_notas' });
    expect(String(error)).toMatch(/linha \d+ fora do formato esperado/);
    expect(String(error)).not.toContain('segredo-nao-numerico');
  });

  it('payload de caixa de saída fora do formato vira erro na leitura', async () => {
    const fake = new FakePostgrest({
      outbox_return_notes: [{ id: 1, invoice_access_key: 'K', payload: { lines: 'x' }, published_at: 'agora', idempotency_key: 'K:1' }],
    });
    const { returnNotes } = supabaseConnectors(new SupabaseRest({ url: 'https://f', secretKey: 'sb_secret_fake', fetch: fake.fetch }));
    await expect(returnNotes.list()).rejects.toMatchObject({ operation: 'parse', table: 'outbox_return_notes' });
  });
});

describe('#59 idempotência das caixas de saída', () => {
  it('publicar duas vezes a mesma mensagem deixa uma linha e devolve o mesmo id', async () => {
    const { dockActions, registryCorrections, returnNotes, fake } = offline();
    const action = DockAction.partial([{ sku: 'SKU-1', quantity: Quantity.of(3, 'CX'), disposition: 'devolver' }]);
    const a = await dockActions.publish({ invoiceAccessKey: 'K1', action });
    const b = await dockActions.publish({ invoiceAccessKey: 'K1', action });
    expect(b.id).toBe(a.id);
    expect(fake.rows('outbox_dock_actions')).toHaveLength(1);

    const correction = { invoiceAccessKey: 'K1', kind: 'E4_fator_de_caixa' as const, supplierCode: 'A', sku: 'SKU-1', detail: 'fator' };
    await registryCorrections.publish(correction);
    await registryCorrections.publish({ ...correction });
    expect(fake.rows('outbox_registry_corrections')).toHaveLength(1);

    const note = { invoiceAccessKey: 'K1', lines: [{ supplierCode: 'A', quantity: Quantity.of(1, 'UN') }], reason: 'avaria' };
    await returnNotes.publish(note);
    await returnNotes.publish(note);
    await returnNotes.publish({ ...note, reason: 'outra' });
    expect(fake.rows('outbox_return_notes')).toHaveLength(2);
  });

  it('a chave é a nota mais o sha256 do JSON canônico: a ordem das chaves não muda o hash', async () => {
    const one = await idempotencyKey('K1', { b: 1, a: [1, { d: 2, c: 3 }] });
    const two = await idempotencyKey('K1', { a: [1, { c: 3, d: 2 }], b: 1 });
    expect(one).toBe(two);
    expect(one).toMatch(/^K1:[0-9a-f]{64}$/);
  });
});
