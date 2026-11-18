/** #230/AC-2 As 11 leituras do auditor sobre o banco da solução: exatamente 1 requisição cada (o orçamento do Cron conta com isso). */
import { describe, expect, it } from 'vitest';
import { SupabaseAuditReads } from '../../src/connectors/audit-reads.js';
import type { AuditReadsPort } from '../../src/connectors/ports.js';
import { scripted } from '../support/scripted-postgrest.js';

const KEY = '35261100000000000000550010000012341000012345';

const CALLS: readonly (readonly [keyof AuditReadsPort, (r: AuditReadsPort) => Promise<unknown>, string])[] = [
  ['getInvoice', (r) => r.getInvoice(KEY), 'invoices'],
  ['getPurchaseOrder', (r) => r.getPurchaseOrder('OC-1'), 'kit_ordens'],
  ['searchPurchaseOrders', (r) => r.searchPurchaseOrders({ supplierId: 'F-001', store: 'L01', status: 'aberta' }), 'kit_ordens'],
  ['getReceipt', (r) => r.getReceipt(KEY), 'kit_recebimentos'],
  ['searchReceiptsWithoutInvoice', (r) => r.searchReceiptsWithoutInvoice({ supplierId: 'F-001', store: 'L01' }), 'kit_recebimentos'],
  ['getRegistry', (r) => r.getRegistry({ sku: 'SKU-1' }), 'kit_produtos'],
  ['getSupplier', (r) => r.getSupplier('F-001'), 'kit_fornecedores'],
  ['searchPostedInvoices', (r) => r.searchPostedInvoices({ supplierId: 'F-001', number: '1234', orderId: 'OC-1' }), 'kit_notas_lancadas'],
  ['searchOutOfFlowPayments', (r) => r.searchOutOfFlowPayments({ supplierId: 'F-001', store: 'L01' }), 'kit_pagamentos'],
  ['compareItems', (r) => r.compareItems(KEY), 'kit_notas'],
  ['getRegua', (r) => r.getRegua(), 'kit_regua'],
];

describe('SupabaseAuditReads (#230)', () => {
  it.each(CALLS)('#230/AC-2: %s custa exatamente 1 requisição de leitura, na tabela esperada', async (_name, call, table) => {
    const { rest, calls } = scripted();
    await call(new SupabaseAuditReads(rest));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.table).toBe(table);
  });

  it('#230/AC-2: nenhuma leitura chama os campos do gabarito nem escreve', async () => {
    const { rest, calls } = scripted();
    const reads = new SupabaseAuditReads(rest);
    for (const [, call] of CALLS) await call(reads);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.some((c) => /gabarito/i.test(c.table))).toBe(false);
  });

  it('#230: a busca filtra no banco pelos argumentos, sem montar filtro com texto livre fora do formato', async () => {
    const { rest, calls } = scripted();
    await new SupabaseAuditReads(rest).searchPurchaseOrders({ supplierId: 'F-001', store: 'L01' });
    expect(calls[0]?.params.get('fornecedor_id')).toBe('eq.F-001');
    expect(calls[0]?.params.get('destino')).toBe('eq.L01');
    expect(calls[0]?.params.has('status')).toBe(false);
  });

  it('#230: o saldo da ordem sai das notas lançadas que a citam (a mesma regra 5 do conector de compras)', async () => {
    const { rest } = scripted(() => ({
      body: [{
        ordem_id: 'OC-1', fornecedor_id: 'F-001', destino: 'L01', data_emissao: '2026-11-01', status: 'aberta', motivo_status: '', valor_total: '100.00',
        kit_ordem_itens: [{ ordem_id: 'OC-1', codigo_fornecedor: 'A1', sku: 'S1', descricao: 'Arroz', quantidade: 10, unidade: 'UN', preco_unitario: '1.00', kit_produtos: { fator_caixa: 1 } }],
        kit_notas_lancadas: [{ chave: 'X', kit_nota_lancada_itens: [{ codigo_fornecedor: 'A1', quantidade: 4, unidade: 'UN' }] }],
      }],
    }));
    const out = (await new SupabaseAuditReads(rest).getPurchaseOrder('OC-1')) as { found: boolean; order: { items: { balance: { amount: number } }[] } };
    expect(out.found).toBe(true);
    expect(out.order.items[0]?.balance.amount).toBe(6);
  });
});
