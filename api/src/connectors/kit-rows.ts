// Linhas das tabelas kit_* (base do kit, ADR-001) e a conversão para os tipos do domínio (#59).
import { Money, Quantity, type Unit } from '../domain/index.js';
import { isBoolean, isInteger, isIsoDate, isString, nullable, oneOf, optional, parseRows, shaped, type Guard, type Shape } from './guards.js';
import type { SelectOptions, SupabaseRest } from './supabase-rest.js';

/** #59 numeric chega do PostgREST como número ou texto, conforme a configuração. */
export type Numeric = number | string;

export type KitFornecedor = {
  fornecedor_id: string; // ADR-001
  razao_social: string; // ADR-001
  cnpj: string; // ADR-001
  bloqueado: boolean; // ADR-001
  motivo_bloqueio: string; // ADR-001
};

export type KitProduto = {
  sku: string; // ADR-001
  descricao: string; // ADR-001
  fornecedor_id: string; // ADR-001
  codigo_fornecedor: string; // ADR-001
  unidade_base: string; // ADR-001
  fator_caixa: number; // ADR-001
  preco_referencia_un: Numeric; // ADR-001
};

export type KitOrdem = {
  ordem_id: string; // ADR-001
  fornecedor_id: string; // ADR-001
  destino: string; // ADR-001
  data_emissao: string; // ADR-001
  status: 'aberta' | 'atendida' | 'travada'; // ADR-001
  motivo_status: string; // ADR-001
  valor_total: Numeric; // ADR-001
};

export type KitOrdemItem = {
  ordem_id: string; // ADR-001
  codigo_fornecedor: string; // ADR-001
  sku: string | null; // ADR-001
  descricao: string; // ADR-001
  quantidade: number; // ADR-001
  unidade: string; // ADR-001
  preco_unitario: Numeric; // ADR-001
};

export type KitNota = {
  chave: string; // ADR-001
  nota_id: string; // ADR-001
  numero: number; // ADR-001
  serie: number; // ADR-001
  fornecedor_id: string; // ADR-001
  destino: string; // ADR-001
  data_emissao: string; // ADR-001
  pedido_referenciado: string | null; // ADR-001
  canal_entrada: string; // ADR-001
  valor_total: Numeric; // ADR-001
  /** #349 De onde vem a nota: a base do kit ou o modo demonstração. Opcional na leitura, para as linhas e os mocks anteriores à coluna. */
  origin?: 'base' | 'demo'; // ADR-001
};

export type KitNotaItem = {
  chave: string; // ADR-001
  codigo_fornecedor: string; // ADR-001
  sku: string | null; // ADR-001
  descricao: string; // ADR-001
  quantidade: number; // ADR-001
  unidade: string; // ADR-001
  preco_unitario: Numeric; // ADR-001
  valor: Numeric; // ADR-001
};

export type KitNotaLancada = {
  chave: string; // ADR-001
  nota_id: string | null; // ADR-001
  numero: number; // ADR-001
  serie: number; // ADR-001
  fornecedor_id: string; // ADR-001
  destino: string; // ADR-001
  data_emissao: string; // ADR-001
  pedido_referenciado: string; // ADR-001
  canal_entrada: string; // ADR-001
  valor_total: Numeric; // ADR-001
  situacao: string; // ADR-001
};

export type KitNotaLancadaItem = KitNotaItem;

export type KitPagamento = {
  pagamento_id: string; // ADR-001
  fornecedor_id: string; // ADR-001
  destino: string; // ADR-001
  data: string; // ADR-001
  valor: Numeric; // ADR-001
  forma: string; // ADR-001
  origem: string; // ADR-001
  nota_chave: string | null; // ADR-001
};

export type KitRecebimento = {
  recebimento_id: string; // ADR-001
  nota_chave: string | null; // ADR-001
  ordem_id: string | null; // ADR-001
  fornecedor_id: string; // ADR-001
  destino: string; // ADR-001
  canal: string; // ADR-001
  data: string; // ADR-001
  observacao: string; // ADR-001
};

export type KitRecebimentoItem = {
  recebimento_id: string; // ADR-001
  codigo_fornecedor: string; // ADR-001
  descricao: string; // ADR-001
  quantidade: number; // ADR-001
  unidade: string; // ADR-001
};

/** #59 Reais do numeric viram centavos inteiros na borda (Money.fromReais). */
export function money(value: Numeric): Money {
  return Money.fromReais(typeof value === 'string' ? Number(value) : value);
}

export function unit(value: string): Unit {
  if (value === 'UN' || value === 'CX') return value;
  throw new Error(`kit: unidade desconhecida ${value}`);
}

export function quantity(amount: number, unitName: string): Quantity {
  return Quantity.of(amount, unit(unitName));
}

/** #59 Agrupa as linhas filhas pela chave do pai, na ordem em que chegaram. */
export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k);
    if (group) group.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

// #59 Guards de cada linha kit_*: o satisfies Shape<T> confere que cobrem todos os campos (ADR-001).

const isNumeric: Guard<Numeric> = (v): v is Numeric =>
  (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
const nullableString = nullable(isString);

const fornecedorShape = {
  fornecedor_id: isString, razao_social: isString, cnpj: isString, bloqueado: isBoolean, motivo_bloqueio: isString, // ADR-001
} satisfies Shape<KitFornecedor>;
export const isKitFornecedorRow = shaped<KitFornecedor>(fornecedorShape);

const produtoShape = {
  sku: isString, descricao: isString, fornecedor_id: isString, codigo_fornecedor: isString, // ADR-001
  unidade_base: isString, fator_caixa: isInteger, preco_referencia_un: isNumeric, // ADR-001
} satisfies Shape<KitProduto>;
export const isKitProdutoRow = shaped<KitProduto>(produtoShape);

const ordemShape = {
  ordem_id: isString, fornecedor_id: isString, destino: isString, data_emissao: isString, // ADR-001
  status: oneOf('aberta', 'atendida', 'travada'), motivo_status: isString, valor_total: isNumeric, // ADR-001
} satisfies Shape<KitOrdem>;
export const isKitOrdemRow = shaped<KitOrdem>(ordemShape);

const ordemItemShape = {
  ordem_id: isString, codigo_fornecedor: isString, sku: nullableString, descricao: isString, // ADR-001
  quantidade: isInteger, unidade: isString, preco_unitario: isNumeric, // ADR-001
} satisfies Shape<KitOrdemItem>;
export const isKitOrdemItemRow = shaped<KitOrdemItem>(ordemItemShape);

const notaShape = {
  chave: isString, nota_id: isString, numero: isInteger, serie: isInteger, fornecedor_id: isString, // ADR-001
  destino: isString, data_emissao: isString, pedido_referenciado: nullableString, canal_entrada: isString, // ADR-001
  valor_total: isNumeric, origin: optional(oneOf('base', 'demo')), // ADR-001
} satisfies Shape<KitNota>;
export const isKitNotaRow = shaped<KitNota>(notaShape);

const notaItemShape = {
  chave: isString, codigo_fornecedor: isString, sku: nullableString, descricao: isString, // ADR-001
  quantidade: isInteger, unidade: isString, preco_unitario: isNumeric, valor: isNumeric, // ADR-001
} satisfies Shape<KitNotaItem>;
export const isKitNotaItemRow = shaped<KitNotaItem>(notaItemShape);

const notaLancadaShape = {
  chave: isString, nota_id: nullableString, numero: isInteger, serie: isInteger, fornecedor_id: isString, // ADR-001
  destino: isString, data_emissao: isString, pedido_referenciado: isString, canal_entrada: isString, // ADR-001
  valor_total: isNumeric, situacao: isString, // ADR-001
} satisfies Shape<KitNotaLancada>;
export const isKitNotaLancadaRow = shaped<KitNotaLancada>(notaLancadaShape);

const pagamentoShape = {
  pagamento_id: isString, fornecedor_id: isString, destino: isString, data: isIsoDate, valor: isNumeric, // ADR-001
  forma: isString, origem: isString, nota_chave: nullableString, // ADR-001
} satisfies Shape<KitPagamento>;
export const isKitPagamentoRow = shaped<KitPagamento>(pagamentoShape);

const recebimentoShape = {
  recebimento_id: isString, nota_chave: nullableString, ordem_id: nullableString, fornecedor_id: isString, // ADR-001
  destino: isString, canal: isString, data: isString, observacao: isString, // ADR-001
} satisfies Shape<KitRecebimento>;
export const isKitRecebimentoRow = shaped<KitRecebimento>(recebimentoShape);

const recebimentoItemShape = {
  recebimento_id: isString, codigo_fornecedor: isString, descricao: isString, quantidade: isInteger, unidade: isString, // ADR-001
} satisfies Shape<KitRecebimentoItem>;
export const isKitRecebimentoItemRow = shaped<KitRecebimentoItem>(recebimentoItemShape);

/** #59 Lê a tabela e valida cada linha antes de devolvê-la tipada. */
export async function readRows<T>(rest: SupabaseRest, table: string, guard: Guard<T>, options: SelectOptions = {}): Promise<T[]> {
  return parseRows(await rest.select(table, options), guard, table);
}
