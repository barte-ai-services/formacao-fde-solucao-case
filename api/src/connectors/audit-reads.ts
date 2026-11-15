// #230 As 11 leituras das tools do auditor (#153) sobre o banco da solução. Cada método custa exatamente 1
// #230 subrequest (o orçamento do Cron conta com isso): um select só, e as tabelas filhas vêm embutidas pelas
// #230 chaves estrangeiras. Nenhuma lê arquivo nem o gabarito; todas só leem. O valor que o modelo passa vai como
// #230 valor de filtro (URLSearchParams o codifica); o que não é do formato esperado volta recusado, sem consulta.
import type { AuditReadsPort } from './ports.js';
import type { Filters, SupabaseRest } from './supabase-rest.js';

const SEARCH_LIMIT = 50;
const eq = (value: string): string => `eq.${value}`;

function filters(base: Filters, extra: Readonly<Record<string, string | undefined>>): Filters {
  const out: Record<string, string> = { ...base };
  for (const [column, value] of Object.entries(extra)) if (value !== undefined) out[column] = eq(value);
  return out;
}

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const rowsOf = (v: unknown[]): Row[] => v.filter(isRow);
const arrayAt = (row: Row, key: string): Row[] => (Array.isArray(row[key]) ? rowsOf(row[key]) : []);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

const ITEMS_OF_ORDER = 'kit_ordem_itens(*,kit_produtos(fator_caixa))';

/** #230 Regra 5 (a do conector de compras): saldo = pedido menos o cobrado nas notas lançadas que citam a ordem, em unidades. */
function withBalances(order: Row): Row {
  const factor = (item: Row): number => {
    const product = item.kit_produtos;
    return isRow(product) ? num(product.fator_caixa) : 1;
  };
  const factors = new Map(arrayAt(order, 'kit_ordem_itens').map((i) => [String(i.codigo_fornecedor), factor(i)]));
  const toUnits = (amount: number, unit: unknown, code: string): number => (unit === 'CX' ? amount * (factors.get(code) ?? 1) : amount);
  const consumed = new Map<string, number>();
  for (const posted of arrayAt(order, 'kit_notas_lancadas')) {
    for (const item of arrayAt(posted, 'kit_nota_lancada_itens')) {
      const code = String(item.codigo_fornecedor);
      consumed.set(code, (consumed.get(code) ?? 0) + toUnits(num(item.quantidade), item.unidade, code));
    }
  }
  const items = arrayAt(order, 'kit_ordem_itens').map((item) => {
    const code = String(item.codigo_fornecedor);
    const ordered = toUnits(num(item.quantidade), item.unidade, code);
    const { kit_produtos: _product, ...rest } = item;
    return { ...rest, balance: { amount: Math.max(0, ordered - (consumed.get(code) ?? 0)), unit: 'UN' } };
  });
  const { kit_notas_lancadas: _posted, kit_ordem_itens: _items, ...header } = order;
  return { ...header, items };
}

export class SupabaseAuditReads implements AuditReadsPort {
  constructor(private readonly rest: SupabaseRest) {}

  async getInvoice(invoiceAccessKey: string): Promise<unknown> {
    const rows = await this.rest.select('invoices', {
      select: 'access_key,number,series,supplier_id,store,issued_on,purchase_order_ref,entry_channel,total_cents,items',
      filters: { access_key: eq(invoiceAccessKey) },
      limit: 1,
    });
    return rows[0] ?? { found: false };
  }

  async getPurchaseOrder(orderId: string): Promise<unknown> {
    const rows = await this.rest.select('kit_ordens', {
      select: `*,${ITEMS_OF_ORDER},kit_notas_lancadas(chave,kit_nota_lancada_itens(codigo_fornecedor,quantidade,unidade))`,
      filters: { ordem_id: eq(orderId) },
      limit: 1,
    });
    const [order] = rowsOf(rows);
    return order ? { found: true, order: withBalances(order) } : { found: false };
  }

  async searchPurchaseOrders(query: { supplierId: string; store?: string; status?: string }): Promise<unknown> {
    const rows = await this.rest.select('kit_ordens', {
      select: '*,kit_ordem_itens(codigo_fornecedor,sku,descricao,quantidade,unidade,preco_unitario)',
      filters: filters({ fornecedor_id: eq(query.supplierId) }, { destino: query.store, status: query.status }),
      order: 'ordem_id',
      limit: SEARCH_LIMIT,
    });
    return { orders: rows };
  }

  async getReceipt(invoiceAccessKey: string): Promise<unknown> {
    const rows = await this.rest.select('kit_recebimentos', {
      select: '*,kit_recebimento_itens(*)',
      filters: { nota_chave: eq(invoiceAccessKey) },
      limit: 1,
    });
    return rows[0] ?? { found: false };
  }

  async searchReceiptsWithoutInvoice(query: { supplierId: string; store: string }): Promise<unknown> {
    const rows = await this.rest.select('kit_recebimentos', {
      select: '*,kit_recebimento_itens(*)',
      filters: { fornecedor_id: eq(query.supplierId), destino: eq(query.store), nota_chave: 'is.null' },
      order: 'recebimento_id',
      limit: SEARCH_LIMIT,
    });
    return { receipts: rows };
  }

  async getRegistry(query: { sku?: string; supplierCode?: string; supplierId?: string }): Promise<unknown> {
    const rows = await this.rest.select('kit_produtos', {
      filters: filters({}, { sku: query.sku, codigo_fornecedor: query.supplierCode, fornecedor_id: query.supplierId }),
      order: 'sku',
      limit: SEARCH_LIMIT,
    });
    return { products: rows };
  }

  async getSupplier(supplierId: string): Promise<unknown> {
    const rows = await this.rest.select('kit_fornecedores', { filters: { fornecedor_id: eq(supplierId) }, limit: 1 });
    return rows[0] ?? { found: false };
  }

  async searchPostedInvoices(query: { supplierId: string; number?: string; orderId?: string }): Promise<unknown> {
    // #230 `numero` é inteiro no banco: um texto que não é número não casa nenhuma nota e não vira filtro inválido.
    if (query.number !== undefined && !/^\d{1,9}$/.test(query.number)) return { invoices: [] };
    const rows = await this.rest.select('kit_notas_lancadas', {
      select: '*,kit_nota_lancada_itens(*)',
      filters: filters({ fornecedor_id: eq(query.supplierId) }, { numero: query.number, pedido_referenciado: query.orderId }),
      order: 'chave',
      limit: SEARCH_LIMIT,
    });
    return { invoices: rows };
  }

  async searchOutOfFlowPayments(query: { supplierId: string; store?: string }): Promise<unknown> {
    const rows = await this.rest.select('kit_pagamentos', {
      filters: filters({ fornecedor_id: eq(query.supplierId), nota_chave: 'is.null' }, { destino: query.store }),
      order: 'pagamento_id',
      limit: SEARCH_LIMIT,
    });
    return { payments: rows };
  }

  /**
   * #230 Nota, ordem e contagem lado a lado, em uma leitura: a nota do kit com os itens, a ordem que ela cita e as
   * contagens dessa ordem para a nota. Nota sem ordem (E5) não traz ordem nem contagem: o modelo usa get_receipt.
   */
  async compareItems(invoiceAccessKey: string): Promise<unknown> {
    const rows = await this.rest.select('kit_notas', {
      select:
        'chave,pedido_referenciado,kit_nota_itens(codigo_fornecedor,descricao,quantidade,unidade,preco_unitario,valor),' +
        'kit_ordens(ordem_id,kit_ordem_itens(codigo_fornecedor,descricao,quantidade,unidade,preco_unitario),' +
        'kit_recebimentos(recebimento_id,nota_chave,kit_recebimento_itens(codigo_fornecedor,descricao,quantidade,unidade)))',
      filters: { chave: eq(invoiceAccessKey) },
      limit: 1,
    });
    const [note] = rowsOf(rows);
    if (!note) return { found: false };
    const order = isRow(note.kit_ordens) ? note.kit_ordens : null;
    const receipts = order ? arrayAt(order, 'kit_recebimentos').filter((r) => r.nota_chave === invoiceAccessKey) : [];
    return {
      found: true,
      invoice: { items: arrayAt(note, 'kit_nota_itens') },
      order: order ? { orderId: order.ordem_id, items: arrayAt(order, 'kit_ordem_itens') } : null,
      receipt: receipts[0] ? { items: arrayAt(receipts[0], 'kit_recebimento_itens') } : null,
    };
  }

  async getRegua(): Promise<unknown> {
    const rows = await this.rest.select('kit_regua', { filters: { id: eq('1') }, limit: 1 });
    return rows[0] ?? { found: false };
  }
}
