// Conector ERP Compras: ordens de compra (kit_ordens, kit_ordem_itens) com o saldo de cada item (#59).
import { Quantity, type PurchaseOrder } from '../domain/index.js';
import {
  groupBy,
  money,
  quantity,
  type KitNotaLancada,
  type KitNotaLancadaItem,
  type KitOrdem,
  type KitOrdemItem,
  type KitProduto,
} from './kit-rows.js';
import type { PurchasingPort } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

export type BalanceInputs = {
  readonly orderItems: readonly KitOrdemItem[];
  readonly postedInvoices: readonly KitNotaLancada[];
  readonly postedItems: readonly KitNotaLancadaItem[];
  readonly products: readonly KitProduto[];
};

/**
 * #59 Regra 5: saldo por item = quantidade da ordem menos o já cobrado nas notas lançadas que citam a
 * ordem, no mesmo código do fornecedor, nunca abaixo de zero (caixa vira unidade pelo fator).
 * Devolve o saldo pela chave `ordem_id|codigo_fornecedor`.
 */
export function deriveBalances(inputs: BalanceInputs): Map<string, Quantity> {
  // Decisão do #59: o kit não traz o saldo da ordem, então o conector o deriva das notas lançadas.
  const orderOfInvoice = new Map(inputs.postedInvoices.map((n) => [n.chave, n.pedido_referenciado]));
  const factorByCode = new Map(inputs.products.map((p) => [p.codigo_fornecedor, p.fator_caixa]));
  const consumed = new Map<string, number>();
  for (const item of inputs.postedItems) {
    const orderId = orderOfInvoice.get(item.chave);
    if (!orderId) continue;
    const key = `${orderId}|${item.codigo_fornecedor}`;
    const units = quantity(item.quantidade, item.unidade).toUnits(factorByCode.get(item.codigo_fornecedor) ?? 1);
    consumed.set(key, (consumed.get(key) ?? 0) + units.amount);
  }
  const balances = new Map<string, Quantity>();
  for (const item of inputs.orderItems) {
    const key = `${item.ordem_id}|${item.codigo_fornecedor}`;
    const ordered = quantity(item.quantidade, item.unidade).toUnits(factorByCode.get(item.codigo_fornecedor) ?? 1);
    balances.set(key, Quantity.of(Math.max(0, ordered.amount - (consumed.get(key) ?? 0)), ordered.unit));
  }
  return balances;
}

export class ErpPurchasingConnector implements PurchasingPort {
  constructor(private readonly rest: SupabaseRest) {}

  async listPurchaseOrders(): Promise<PurchaseOrder[]> {
    const [ordens, orderItems, postedInvoices, postedItems, products] = await Promise.all([
      this.rest.select<KitOrdem>('kit_ordens', { order: 'ordem_id' }),
      this.rest.select<KitOrdemItem>('kit_ordem_itens', { order: 'ordem_id,codigo_fornecedor' }),
      this.rest.select<KitNotaLancada>('kit_notas_lancadas', { order: 'chave' }),
      this.rest.select<KitNotaLancadaItem>('kit_nota_lancada_itens', { order: 'chave,codigo_fornecedor' }),
      this.rest.select<KitProduto>('kit_produtos', { order: 'sku' }),
    ]);
    const balances = deriveBalances({ orderItems, postedInvoices, postedItems, products });
    const itemsByOrder = groupBy(orderItems, (i) => i.ordem_id);
    return ordens.map((o) => ({
      id: o.ordem_id,
      supplierId: o.fornecedor_id,
      store: o.destino,
      issuedOn: o.data_emissao,
      status: o.status,
      statusReason: o.motivo_status,
      total: money(o.valor_total),
      items: (itemsByOrder.get(o.ordem_id) ?? []).map((i) => {
        const ordered = quantity(i.quantidade, i.unidade);
        return {
          // #59 O domínio pede sku texto; o item da ordem sem cadastro (sku nulo no kit) vem vazio.
          sku: i.sku,
          supplierCode: i.codigo_fornecedor,
          description: i.descricao,
          quantity: ordered,
          unitPrice: money(i.preco_unitario),
          balance: balances.get(`${i.ordem_id}|${i.codigo_fornecedor}`) ?? ordered,
        };
      }),
    }));
  }
}
