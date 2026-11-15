// Notas do kit gravadas na tabela invoices no formato da migração do domínio (#72). Só os testes leem o kit.
import { readFileSync } from 'node:fs';

type KitItem = {
  codigo_fornecedor: string; // ADR-001
  sku: string | null; // ADR-001
  descricao: string; // ADR-001
  quantidade: number; // ADR-001
  unidade: 'UN' | 'CX'; // ADR-001
  preco_unitario: number; // ADR-001
  valor: number; // ADR-001
};

type KitNote = {
  chave: string; // ADR-001
  numero: number; // ADR-001
  serie: number; // ADR-001
  fornecedor_id: string; // ADR-001
  destino: string; // ADR-001
  data_emissao: string; // ADR-001
  pedido_referenciado: string | null; // ADR-001
  canal_entrada: string; // ADR-001
  itens: KitItem[]; // ADR-001
  valor_total: number; // ADR-001
};

export function kitNotes(): KitNote[] {
  return JSON.parse(readFileSync(new URL('../../../data/kit/notas.json', import.meta.url), 'utf8')) as KitNote[];
}

const cents = (value: number) => Math.round(value * 100);

/** #72 A nota do kit como linha de public.invoices (20261115130000_dominio.sql). */
export function invoiceRow(note: KitNote): Record<string, unknown> {
  return {
    access_key: note.chave,
    number: String(note.numero),
    series: String(note.serie),
    supplier_id: note.fornecedor_id,
    store: note.destino,
    issued_on: note.data_emissao,
    purchase_order_ref: note.pedido_referenciado,
    entry_channel: note.canal_entrada,
    total_cents: cents(note.valor_total),
    items: note.itens.map((i) => ({
      supplierCode: i.codigo_fornecedor,
      sku: i.sku,
      description: i.descricao,
      quantity: { amount: i.quantidade, unit: i.unidade },
      unitPriceCents: cents(i.preco_unitario),
      totalCents: cents(i.valor),
    })),
    state: 'com_proposta',
  };
}

export function kitInvoiceRows(): Record<string, unknown>[] {
  return kitNotes().map(invoiceRow);
}

/** #72 As notas do kit de um destino num dia, ordenadas pelo número. */
export function kitNotesOf(destination: string, date: string): KitNote[] {
  return kitNotes()
    .filter((n) => n.destino === destination && n.data_emissao === date)
    .sort((a, b) => a.numero - b.numero);
}
