// Conector Banco: os pagamentos (kit_pagamentos), inclusive os fora do fluxo (#59).
import type { Payment } from '../domain/index.js';
import { money, type KitPagamento, isKitPagamentoRow, readRows } from './kit-rows.js';
import type { BankPort } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

export class BankConnector implements BankPort {
  constructor(private readonly rest: SupabaseRest) {}

  async listPayments(): Promise<Payment[]> {
    const rows = await readRows(this.rest, 'kit_pagamentos', isKitPagamentoRow, { order: 'pagamento_id' });
    return rows.map((p) => ({
      id: p.pagamento_id,
      supplierId: p.fornecedor_id,
      store: p.destino,
      paidOn: p.data,
      amount: money(p.valor),
      method: p.forma,
      origin: p.origem,
      invoiceAccessKey: p.nota_chave,
    }));
  }
}
