// #63 Os casos da base do kit (data/kit/*.json) montados como objetos do domínio, para os testes da régua.
// O gabarito do kit não está no repositório; a classificação de cada caso vem da verificação ou do teste.
import { readFileSync } from 'node:fs';
import {
  Divergence,
  Invoice,
  Money,
  Quantity,
  type CheckContext,
  type Classification,
  type PurchaseOrder,
  type Supplier,
  type Unit,
} from '../../src/domain/index.js';

type Json = Record<string, unknown>;

function readKit<T = Json>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../../data/kit/${name}.json`, import.meta.url), 'utf8')) as T;
}

type KitItem = {
  codigo_fornecedor: string;
  sku: string | null;
  descricao: string;
  quantidade: number;
  unidade: Unit;
  preco_unitario: number;
  valor?: number;
};

type KitNote = {
  nota_id: string;
  chave: string;
  numero: number;
  serie: number;
  fornecedor_id: string;
  destino: string;
  data_emissao: string;
  pedido_referenciado: string | null;
  canal_entrada: string;
  itens: KitItem[];
  valor_total: number;
};

type KitOrder = {
  ordem_id: string;
  fornecedor_id: string;
  destino: string;
  data_emissao: string;
  status: PurchaseOrder['status'];
  motivo_status: string;
  itens: KitItem[];
  valor_total: number;
};

type KitSupplier = { fornecedor_id: string; razao_social: string; cnpj: string; bloqueado: boolean; motivo_bloqueio: string };

export type Regua = {
  tolerancia_valor: number;
  tolerancia_percentual: number;
  teto_regra_tolerancia: number;
  teto_analista: number;
  teto_coordenacao: number;
  niveis: string[];
};

export const kitRegua = (): Regua => readKit<Regua>('regua');

const notes = readKit<KitNote[]>('notas');

export function kitInvoice(notaId: string): Invoice {
  const n = notes.find((x) => x.nota_id === notaId);
  if (!n) throw new Error(`nota ${notaId} não está no kit`);
  return Invoice.receive({
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
      total: Money.fromReais(i.valor ?? i.quantidade * i.preco_unitario),
    })),
    total: Money.fromReais(n.valor_total),
  });
}

export function kitContext(): CheckContext {
  const orders = readKit<KitOrder[]>('ordens').map(
    (o): PurchaseOrder => ({
      id: o.ordem_id,
      supplierId: o.fornecedor_id,
      store: o.destino,
      issuedOn: o.data_emissao,
      status: o.status,
      statusReason: o.motivo_status,
      items: o.itens.map((i) => ({
        sku: i.sku,
        supplierCode: i.codigo_fornecedor,
        description: i.descricao,
        quantity: Quantity.of(i.quantidade, i.unidade),
        unitPrice: Money.fromReais(i.preco_unitario),
        balance: Quantity.of(i.quantidade, i.unidade),
      })),
      total: Money.fromReais(o.valor_total),
    }),
  );
  return {
    purchaseOrders: orders,
    suppliers: kitSuppliers(),
    products: [],
    postedInvoices: [],
    payments: [],
    receipts: [],
    capturedInvoices: [],
  };
}

export function kitSuppliers(): Supplier[] {
  return readKit<KitSupplier[]>('fornecedores').map((s) => ({
    id: s.fornecedor_id,
    legalName: s.razao_social,
    cnpj: s.cnpj,
    paymentBlocked: s.bloqueado,
    blockReason: s.motivo_bloqueio,
  }));
}

export const kitSupplier = (id: string): Supplier | undefined => kitSuppliers().find((s) => s.id === id);

/**
 * Confere a nota com divergências dadas pelo teste, no lugar das verificações das outras histórias.
 * Cada divergência cita o registro do kit que a sustenta (regra 6).
 */
export function checkedWith(invoice: Invoice, ...classifications: Exclude<Classification, 'MATCH'>[]): Invoice {
  const divergences = classifications.map((classification) =>
    Divergence.of({
      classification,
      skus: invoice.items.flatMap((i) => (i.sku ? [i.sku] : [])).slice(0, 1),
      evidence: [{ source: 'sefaz', reference: invoice.accessKey, description: `caso ${classification} do kit` }],
    }),
  );
  invoice.check(kitContext(), [{ id: 'E6', run: () => [] }, { id: 'NAO_CATALOGADA', run: () => divergences }]);
  return invoice;
}
