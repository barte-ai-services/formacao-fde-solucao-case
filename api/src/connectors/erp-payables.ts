// Conector ERP Contas a pagar: as notas já lançadas (kit_notas_lancadas) (#59).
import type { PostedInvoice } from '../domain/index.js';
import { money, type KitNotaLancada } from './kit-rows.js';
import type { PayablesPort } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

export class ErpPayablesConnector implements PayablesPort {
  constructor(private readonly rest: SupabaseRest) {}

  async listPostedInvoices(): Promise<PostedInvoice[]> {
    const rows = await this.rest.select<KitNotaLancada>('kit_notas_lancadas', { order: 'chave' });
    return rows.map((n) => ({
      accessKey: n.chave,
      number: String(n.numero),
      supplierId: n.fornecedor_id,
      purchaseOrderRef: n.pedido_referenciado,
      total: money(n.valor_total),
      status: n.situacao,
    }));
  }
}
