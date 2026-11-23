import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BLOCKED_SUPPLIER, PRODUCTS, SUPPLIERS, UNREGISTERED_ITEMS } from '../../src/demo/catalog.js';

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function kit(name: string): Json[] {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`../../../data/kit/${name}.json`, import.meta.url), 'utf8'));
  if (!Array.isArray(parsed)) throw new TypeError(`data/kit/${name}.json: esperava uma lista`);
  return parsed.filter(isJson);
}

describe('#349 o catálogo do gerador é o do kit', () => {
  it('os fornecedores batem com data/kit/fornecedores.json', () => {
    const expected = kit('fornecedores').map((f) => ({
      id: f.fornecedor_id,
      name: f.razao_social,
      cnpjDigits: String(f.cnpj).replace(/\D/g, ''),
      blocked: f.bloqueado,
    }));
    expect(SUPPLIERS.map((s) => ({ ...s }))).toEqual(expected);
    expect(SUPPLIERS.filter((s) => s.blocked).map((s) => s.id)).toEqual([BLOCKED_SUPPLIER]);
  });

  it('os produtos batem com data/kit/produtos.json', () => {
    const expected = kit('produtos').map((p) => ({
      sku: p.sku,
      supplierId: p.fornecedor_id,
      supplierCode: p.codigo_fornecedor,
      description: p.descricao,
      boxFactor: p.fator_caixa,
      priceCents: Math.round(Number(p.preco_referencia_un) * 100),
    }));
    expect(PRODUCTS.map((p) => ({ ...p }))).toEqual(expected);
  });

  it('o item sem cadastro de cada fornecedor não está no cadastro do kit', () => {
    const descriptions = new Set(kit('produtos').map((p) => p.descricao));
    for (const [supplierId, item] of Object.entries(UNREGISTERED_ITEMS)) {
      expect(SUPPLIERS.some((s) => s.id === supplierId)).toBe(true);
      expect(descriptions.has(item.description)).toBe(false);
    }
  });
});
