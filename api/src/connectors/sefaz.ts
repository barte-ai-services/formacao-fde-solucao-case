// Conector SEFAZ: as notas da base do kit (kit_notas, kit_nota_itens) viram Invoice a conferir (#59).
import { Invoice } from '../domain/index.js';
import { groupBy, money, quantity, type KitNota, type KitNotaItem, isKitNotaItemRow, isKitNotaRow, readRows } from './kit-rows.js';
import type { SefazPort } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

export class SefazConnector implements SefazPort {
  constructor(private readonly rest: SupabaseRest) {}

  /** #362 A mesma leitura das notas de listIssuedInvoices, para a rodada que lê as duas pagar a das notas uma vez só. */
  private readInvoiceRows(): Promise<KitNota[]> {
    return readRows(this.rest, 'kit_notas', isKitNotaRow, { order: 'chave' });
  }

  async listIssuedKeys(): Promise<string[]> {
    return (await this.readInvoiceRows()).map((n) => n.chave);
  }

  async listIssuedInvoices(): Promise<Invoice[]> {
    const [invoiceRows, itens] = await Promise.all([
      this.readInvoiceRows(),
      readRows(this.rest, 'kit_nota_itens', isKitNotaItemRow, { order: 'chave,codigo_fornecedor' }),
    ]);
    const itemsByKey = groupBy(itens, (i) => i.chave);
    return invoiceRows.map((n) =>
      Invoice.receive({
        accessKey: n.chave,
        number: String(n.numero),
        series: String(n.serie),
        supplierId: n.fornecedor_id,
        store: n.destino,
        issuedOn: n.data_emissao,
        purchaseOrderRef: n.pedido_referenciado,
        entryChannel: n.canal_entrada,
        items: (itemsByKey.get(n.chave) ?? []).map((i) => ({
          supplierCode: i.codigo_fornecedor,
          sku: i.sku,
          description: i.descricao,
          quantity: quantity(i.quantidade, i.unidade),
          unitPrice: money(i.preco_unitario),
          total: money(i.valor),
        })),
        total: money(n.valor_total),
      }),
    );
  }
}
