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
    kit_ordens: [],
    kit_ordem_itens: [],
    kit_notas_lancadas: [],
    kit_nota_lancada_itens: [],
    kit_notas: [],
    kit_nota_itens: [],
    kit_recebimentos: [],
    kit_recebimento_itens: [],
    kit_pagamentos: [],
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
      ordem_id: order.id,
      fornecedor_id: order.supplierId,
      destino: order.store,
      data_emissao: order.issuedOn,
      status: order.status,
      motivo_status: order.statusReason,
      valor_total: reais(totalCents(order.items)),
    });
    for (const item of order.items) {
      this.rows.kit_ordem_itens.push({
        ordem_id: order.id,
        codigo_fornecedor: item.code,
        sku: item.sku,
        descricao: item.description,
        quantidade: item.quantity,
        unidade: item.unit,
        preco_unitario: reais(item.priceCents),
      });
    }
  }

  /** A nota lançada no contas a pagar (kit_notas_lancadas): o `nota_id` é nulo, como em toda a fonte. */
  addPostedNote(note: NoteInput, situation: 'lançada' | 'paga'): void {
    this.rows.kit_notas_lancadas.push({
      chave: note.key,
      nota_id: null,
      numero: note.number,
      serie: 1,
      fornecedor_id: note.supplierId,
      destino: note.store,
      data_emissao: note.issuedOn,
      pedido_referenciado: note.orderId ?? '',
      canal_entrada: note.channel,
      valor_total: reais(totalCents(note.items)),
      situacao: situation,
    });
    this.rows.kit_nota_lancada_itens.push(...noteItemRows(note));
  }

  addNote(note: NoteInput): void {
    const row: DemoNotaRow = {
      chave: note.key,
      nota_id: note.noteId ?? '',
      numero: note.number,
      serie: 1,
      fornecedor_id: note.supplierId,
      destino: note.store,
      data_emissao: note.issuedOn,
      pedido_referenciado: note.orderId,
      canal_entrada: note.channel,
      valor_total: reais(totalCents(note.items)),
      origin: 'demo',
    };
    this.rows.kit_notas.push(row);
    this.rows.kit_nota_itens.push(...noteItemRows(note));
  }

  addReceipt(receipt: ReceiptInput): void {
    this.rows.kit_recebimentos.push({
      recebimento_id: receipt.id,
      nota_chave: receipt.noteKey,
      ordem_id: receipt.orderId,
      fornecedor_id: receipt.supplierId,
      destino: receipt.store,
      canal: receipt.store.startsWith('CD') ? 'doca_cd' : 'app_loja',
      data: receipt.receivedOn,
      observacao: receipt.note,
    });
    for (const line of receipt.lines) {
      this.rows.kit_recebimento_itens.push({
        recebimento_id: receipt.id,
        codigo_fornecedor: line.code,
        descricao: line.description,
        quantidade: line.quantity,
        unidade: line.unit,
      });
    }
  }

  addPayment(payment: PaymentInput): void {
    this.rows.kit_pagamentos.push({
      pagamento_id: payment.id,
      fornecedor_id: payment.supplierId,
      destino: payment.store,
      data: payment.paidOn,
      valor: reais(payment.cents),
      forma: payment.method,
      origem: 'compra emergencial da loja, fora do fluxo',
      nota_chave: null,
    });
  }
}

function noteItemRows(note: NoteInput): DemoRows['kit_nota_itens'] {
  return note.items.map((item) => ({
    chave: note.key,
    codigo_fornecedor: item.code,
    sku: item.sku,
    descricao: item.description,
    quantidade: item.quantity,
    unidade: item.unit,
    preco_unitario: reais(item.priceCents),
    valor: reais(itemCents(item)),
  }));
}

export const receiptLinesOf = (items: readonly DemoItem[]): ReceiptLine[] =>
  items.map((item) => ({ code: item.code, description: item.description, quantity: item.quantity, unit: item.unit }));
