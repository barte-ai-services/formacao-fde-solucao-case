// Linhas das tabelas kit_* (base do kit, ADR-001) e a conversão para os tipos do domínio (#59).
import { Money, Quantity, type Unit } from '../domain/index.js';

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
