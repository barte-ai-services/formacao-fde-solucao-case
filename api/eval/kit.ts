// #65 Carrega a base do kit (data/kit/*.json, a fonte que o Supabase espelha) no formato do domínio, para o eval.
// #65 só o eval usa este arquivo; a aplicação lê o kit pelos conectores.
import { readFileSync } from 'node:fs';
import {
  Invoice,
  Money,
  Quantity,
  type CheckContext,
  type InvoiceView,
  type Product,
  type PurchaseOrder,
  type Unit,
} from '../src/domain/index.js';

type KitItem = {
  codigo_fornecedor: string; // ADR-001
  sku: string | null; // ADR-001
  descricao: string; // ADR-001
  quantidade: number; // ADR-001
  unidade: Unit; // ADR-001
  preco_unitario: number; // ADR-001
};
type KitNota = {
  nota_id: string | null; // ADR-001
  chave: string; // ADR-001
  numero: number; // ADR-001
  serie: number; // ADR-001
  fornecedor_id: string; // ADR-001
  destino: string; // ADR-001
  data_emissao: string; // ADR-001
  pedido_referenciado: string | null; // ADR-001
  canal_entrada: string; // ADR-001
  itens: (KitItem & { valor: number })[]; // ADR-001
  valor_total: number; // ADR-001
};
type KitOrdem = {
  ordem_id: string; // ADR-001
  fornecedor_id: string; // ADR-001
  destino: string; // ADR-001
  data_emissao: string; // ADR-001
  status: PurchaseOrder['status']; // ADR-001
  motivo_status: string; // ADR-001
  itens: KitItem[]; // ADR-001
  valor_total: number; // ADR-001
};
type KitProduto = {
  sku: string; // ADR-001
  descricao: string; // ADR-001
  fornecedor_id: string; // ADR-001
  codigo_fornecedor: string; // ADR-001
  unidade_base: Unit; // ADR-001
  fator_caixa: number; // ADR-001
  preco_referencia_un: number; // ADR-001
};

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../../data/kit/${name}.json`, import.meta.url), 'utf8')) as T;

export type KitInvoice = { readonly id: string; readonly invoice: InvoiceView };

export type Kit = { readonly invoices: readonly KitInvoice[]; readonly ctx: CheckContext };

/**
 * Regra 5: o saldo do item da ordem é a quantidade pedida menos o já cobrado nas notas lançadas que a
 * citam, em unidade, nunca abaixo de zero. Mesma derivação do conector de Compras (#59), aqui só para o eval.
 */
function balances(ordens: readonly KitOrdem[], lancadas: readonly KitNota[], factor: (code: string) => number) {
  const consumed = new Map<string, number>();
  for (const n of lancadas) {
    if (!n.pedido_referenciado) continue;
    for (const i of n.itens) {
      const key = `${n.pedido_referenciado}|${i.codigo_fornecedor}`;
      const units = Quantity.of(i.quantidade, i.unidade).toUnits(factor(i.codigo_fornecedor)).amount;
      consumed.set(key, (consumed.get(key) ?? 0) + units);
    }
  }
  return (o: KitOrdem, i: KitItem): Quantity => {
    const ordered = Quantity.of(i.quantidade, i.unidade).toUnits(factor(i.codigo_fornecedor));
    const left = ordered.amount - (consumed.get(`${o.ordem_id}|${i.codigo_fornecedor}`) ?? 0);
    return Quantity.of(Math.max(0, left), 'UN');
  };
}

export function loadKit(): Kit {
  const notas = read<KitNota[]>('notas');
  const ordens = read<KitOrdem[]>('ordens');
  const lancadas = read<KitNota[]>('notas_lancadas');
  const produtos = read<KitProduto[]>('produtos');

  const products: Product[] = produtos.map((p) => ({
    sku: p.sku,
    description: p.descricao,
    supplierId: p.fornecedor_id,
    supplierCode: p.codigo_fornecedor,
    baseUnit: p.unidade_base,
    boxFactor: p.fator_caixa,
    referenceUnitPrice: Money.fromReais(p.preco_referencia_un),
  }));
  const factorByCode = new Map(products.map((p) => [p.supplierCode, p.boxFactor]));
  const factor = (code: string) => factorByCode.get(code) ?? 1;
  const balanceOf = balances(ordens, lancadas, factor);

  const purchaseOrders: PurchaseOrder[] = ordens.map((o) => ({
    id: o.ordem_id,
    supplierId: o.fornecedor_id,
    store: o.destino,
    issuedOn: o.data_emissao,
    status: o.status,
    statusReason: o.motivo_status,
    total: Money.fromReais(o.valor_total),
    items: o.itens.map((i) => ({
      sku: i.sku,
      supplierCode: i.codigo_fornecedor,
      description: i.descricao,
      quantity: Quantity.of(i.quantidade, i.unidade),
      unitPrice: Money.fromReais(i.preco_unitario),
      balance: balanceOf(o, i),
    })),
  }));

  const invoices: KitInvoice[] = notas.map((n) => ({
    id: n.nota_id ?? n.chave,
    invoice: Invoice.receive({
      accessKey: n.chave,
      number: String(n.numero),
      series: String(n.serie),
      supplierId: n.fornecedor_id,
      store: n.destino,
      issuedOn: n.data_emissao,
      purchaseOrderRef: n.pedido_referenciado,
      entryChannel: n.canal_entrada,
      items: n.itens.map((i) => ({
        supplierCode: i.codigo_fornecedor,
        sku: i.sku,
        description: i.descricao,
        quantity: Quantity.of(i.quantidade, i.unidade),
        unitPrice: Money.fromReais(i.preco_unitario),
        total: Money.fromReais(i.valor),
      })),
      total: Money.fromReais(n.valor_total),
    }),
  }));

  return {
    invoices,
    ctx: {
      purchaseOrders,
      suppliers: [],
      products,
      postedInvoices: [],
      payments: [],
      receipts: [],
      capturedInvoices: [],
    },
  };
}
