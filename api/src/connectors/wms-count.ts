// Conector WMS (contagem): os recebimentos (kit_recebimentos, kit_recebimento_itens) (#59).
import type { Receipt } from '../domain/index.js';
import { groupBy, quantity, type KitRecebimento, type KitRecebimentoItem } from './kit-rows.js';
import type { WmsCountPort } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

export class WmsCountConnector implements WmsCountPort {
  constructor(private readonly rest: SupabaseRest) {}

  async listReceipts(): Promise<Receipt[]> {
    const [recebimentos, itens] = await Promise.all([
      this.rest.select<KitRecebimento>('kit_recebimentos', { order: 'recebimento_id' }),
      this.rest.select<KitRecebimentoItem>('kit_recebimento_itens', { order: 'recebimento_id,codigo_fornecedor' }),
    ]);
    const itemsById = groupBy(itens, (i) => i.recebimento_id);
    return recebimentos.map((r) => ({
      id: r.recebimento_id,
      // #59 O domínio pede a chave como texto; o recebimento sem nota (nota_chave nula no kit) vem vazio.
      invoiceAccessKey: r.nota_chave,
      purchaseOrderId: r.ordem_id,
      supplierId: r.fornecedor_id,
      store: r.destino,
      receivedOn: r.data,
      note: r.observacao,
      items: (itemsById.get(r.recebimento_id) ?? []).map((i) => ({
        supplierCode: i.codigo_fornecedor,
        description: i.descricao,
        quantity: quantity(i.quantidade, i.unidade),
      })),
    }));
  }
}
