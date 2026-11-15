/**
 * Linhas do kit que o Claude no Worker lê (#66): os tipos espelham as colunas das tabelas kit_*
 * e mantêm os nomes em português da fonte (docs/adr/ADR-001-kit-base-names.md), cada linha marcada.
 * Cada tipo tem o guard que o estreita a partir de unknown (#66).
 */
import { arrayOf, isString, nullable, shaped, type Guard, type Shape } from './guards.js';

export type KitNota = {
  readonly chave: string; // ADR-001
  readonly fornecedor_id: string; // ADR-001
};

export type KitNotaItem = {
  readonly chave: string; // ADR-001
  readonly codigo_fornecedor: string; // ADR-001
  readonly sku: string | null; // ADR-001
  readonly descricao: string; // ADR-001
};

export type KitProduto = {
  readonly sku: string; // ADR-001
  readonly descricao: string; // ADR-001
  readonly fornecedor_id: string; // ADR-001
  readonly codigo_fornecedor: string; // ADR-001
};

/** #66 Uma nota do notas.json do kit, com os itens aninhados como na fonte. */
export type KitNotaWithItems = {
  readonly chave: string; // ADR-001
  readonly fornecedor_id: string; // ADR-001
  readonly itens: readonly Pick<KitNotaItem, 'codigo_fornecedor' | 'sku' | 'descricao'>[]; // ADR-001
};

export const isKitNota: Guard<KitNota> = shaped<KitNota>({
  chave: isString, // ADR-001
  fornecedor_id: isString,
} satisfies Shape<KitNota>);

export const isKitNotaItem: Guard<KitNotaItem> = shaped<KitNotaItem>({
  chave: isString, // ADR-001
  codigo_fornecedor: isString,
  sku: nullable(isString),
  descricao: isString,
} satisfies Shape<KitNotaItem>);

export const isKitProduto: Guard<KitProduto> = shaped<KitProduto>({
  sku: isString,
  descricao: isString,
  fornecedor_id: isString,
  codigo_fornecedor: isString,
} satisfies Shape<KitProduto>);

const isNestedItem = shaped<KitNotaWithItems['itens'][number]>({
  codigo_fornecedor: isString,
  sku: nullable(isString),
  descricao: isString,
});

export const isKitNotaWithItems: Guard<KitNotaWithItems> = shaped<KitNotaWithItems>({
  chave: isString, // ADR-001
  fornecedor_id: isString,
  itens: arrayOf(isNestedItem),
} satisfies Shape<KitNotaWithItems>);
