// Montagem das linhas kit_* de um lote gerado (#349): valores em centavos inteiros na entrada, reais nas linhas.
import type { DemoNotaRow, DemoRows } from './types.js';

export type Unit = 'UN' | 'CX';

export type DemoItem = {
  readonly sku: string | null;
  readonly code: string;
  readonly description: string;
  readonly quantity: number;
  readonly unit: Unit;
  readonly priceCents: number;
};

export type ReceiptLine = { readonly code: string; readonly description: string; readonly quantity: number; readonly unit: Unit };

export const reais = (cents: number): number => cents / 100;
export const itemCents = (item: DemoItem): number => item.quantity * item.priceCents;
export const totalCents = (items: readonly DemoItem[]): number => items.reduce((sum, item) => sum + itemCents(item), 0);

export function emptyRows(): DemoRows {
  return {
    kit_ordens: [], // ADR-001
    kit_ordem_itens: [], // ADR-001
    kit_notas_lancadas: [], // ADR-001
    kit_nota_lancada_itens: [], // ADR-001
    kit_notas: [], // ADR-001
    kit_nota_itens: [], // ADR-001
    kit_recebimentos: [], // ADR-001
    kit_recebimento_itens: [], // ADR-001
    kit_pagamentos: [], // ADR-001
  };
}

export type OrderInput = {
  readonly id: string;
  readonly supplierId: string;
  readonly store: string;
  readonly issuedOn: string;
  readonly status: 'aberta' | 'atendida' | 'travada';
  readonly statusReason: string;
  readonly items: readonly DemoItem[];
};

export type NoteInput = {
  readonly key: string;
  readonly noteId: string | null;
  readonly number: number;
  readonly supplierId: string;
  readonly store: string;
  readonly issuedOn: string;
  readonly orderId: string | null;
  readonly channel: string;
  readonly items: readonly DemoItem[];
};

export type ReceiptInput = {
  readonly id: string;
  readonly noteKey: string | null;
  readonly orderId: string | null;
  readonly supplierId: string;
  readonly store: string;
  readonly receivedOn: string;
  readonly note: string;
  readonly lines: readonly ReceiptLine[];
};

export type PaymentInput = {
  readonly id: string;
  readonly supplierId: string;
  readonly store: string;
  readonly paidOn: string;
  readonly cents: number;
  readonly method: string;
};

export class RowSink {
  readonly rows: DemoRows = emptyRows();

  addOrder(order: OrderInput): void {
    this.rows.kit_ordens.push({
      ordem_id: order.id, // ADR-001
      fornecedor_id: order.supplierId, // ADR-001
      destino: order.store, // ADR-001
      data_emissao: order.issuedOn, // ADR-001
      status: order.status, // ADR-001
      motivo_status: order.statusReason, // ADR-001
      valor_total: reais(totalCents(order.items)), // ADR-001
    });
    for (const item of order.items) {
      this.rows.kit_ordem_itens.push({
        ordem_id: order.id, // ADR-001
        codigo_fornecedor: item.code, // ADR-001
        sku: item.sku, // ADR-001
        descricao: item.description, // ADR-001
        quantidade: item.quantity, // ADR-001
        unidade: item.unit, // ADR-001
        preco_unitario: reais(item.priceCents), // ADR-001
      });
    }
  }

  /** A nota lançada no contas a pagar (kit_notas_lancadas): o `nota_id` é nulo, como em toda a fonte. (#349) */
  addPostedNote(note: NoteInput, situation: 'lançada' | 'paga'): void {
    this.rows.kit_notas_lancadas.push({
      chave: note.key, // ADR-001
      nota_id: null, // ADR-001
      numero: note.number, // ADR-001
      serie: 1, // ADR-001
      fornecedor_id: note.supplierId, // ADR-001
      destino: note.store, // ADR-001
      data_emissao: note.issuedOn, // ADR-001
      pedido_referenciado: note.orderId ?? '', // ADR-001
      canal_entrada: note.channel, // ADR-001
      valor_total: reais(totalCents(note.items)), // ADR-001
      situacao: situation, // ADR-001
    });
    this.rows.kit_nota_lancada_itens.push(...noteItemRows(note));
  }

  addNote(note: NoteInput): void {
    const row: DemoNotaRow = {
      chave: note.key, // ADR-001
      nota_id: note.noteId ?? '', // ADR-001
      numero: note.number, // ADR-001
      serie: 1, // ADR-001
      fornecedor_id: note.supplierId, // ADR-001
      destino: note.store, // ADR-001
      data_emissao: note.issuedOn, // ADR-001
      pedido_referenciado: note.orderId, // ADR-001
      canal_entrada: note.channel, // ADR-001
      valor_total: reais(totalCents(note.items)), // ADR-001
      origin: 'demo',
    };
    this.rows.kit_notas.push(row);
    this.rows.kit_nota_itens.push(...noteItemRows(note));
  }

  addReceipt(receipt: ReceiptInput): void {
    this.rows.kit_recebimentos.push({
      recebimento_id: receipt.id, // ADR-001
      nota_chave: receipt.noteKey, // ADR-001
      ordem_id: receipt.orderId, // ADR-001
      fornecedor_id: receipt.supplierId, // ADR-001
      destino: receipt.store, // ADR-001
      canal: receipt.store.startsWith('CD') ? 'doca_cd' : 'app_loja', // ADR-001
      data: receipt.receivedOn, // ADR-001
      observacao: receipt.note, // ADR-001
    });
    for (const line of receipt.lines) {
      this.rows.kit_recebimento_itens.push({
        recebimento_id: receipt.id, // ADR-001
        codigo_fornecedor: line.code, // ADR-001
        descricao: line.description, // ADR-001
        quantidade: line.quantity, // ADR-001
        unidade: line.unit, // ADR-001
      });
    }
  }

  addPayment(payment: PaymentInput): void {
    this.rows.kit_pagamentos.push({
      pagamento_id: payment.id, // ADR-001
      fornecedor_id: payment.supplierId, // ADR-001
      destino: payment.store, // ADR-001
      data: payment.paidOn, // ADR-001
      valor: reais(payment.cents), // ADR-001
      forma: payment.method, // ADR-001
      origem: 'compra emergencial da loja, fora do fluxo', // ADR-001
      nota_chave: null, // ADR-001
    });
  }
}

function noteItemRows(note: NoteInput): DemoRows['kit_nota_itens'] {
  return note.items.map((item) => ({
    chave: note.key, // ADR-001
    codigo_fornecedor: item.code, // ADR-001
    sku: item.sku, // ADR-001
    descricao: item.description, // ADR-001
    quantidade: item.quantity, // ADR-001
    unidade: item.unit, // ADR-001
    preco_unitario: reais(item.priceCents), // ADR-001
    valor: reais(itemCents(item)), // ADR-001
  }));
}

export const receiptLinesOf = (items: readonly DemoItem[]): ReceiptLine[] =>
  items.map((item) => ({ code: item.code, description: item.description, quantity: item.quantity, unit: item.unit }));
