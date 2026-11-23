import { describe, expect, it } from 'vitest';
import { kitBaseCounts, kitCounts, kitTables, type FoundRow } from '../support/kit.js';

// #349 A conferência online conta só as linhas da base: as do modo demonstração entram nas mesmas tabelas e não estão no JSON.
const PARENTS: Readonly<Record<string, { key: string; items: string | null }>> = {
  kit_notas: { key: 'chave', items: 'kit_nota_itens' },
  kit_ordens: { key: 'ordem_id', items: 'kit_ordem_itens' },
  kit_notas_lancadas: { key: 'chave', items: 'kit_nota_lancada_itens' },
  kit_pagamentos: { key: 'pagamento_id', items: null },
  kit_recebimentos: { key: 'recebimento_id', items: 'kit_recebimento_itens' },
};

function asFound(table: string): FoundRow[] {
  const spec = PARENTS[table];
  const tables = kitTables();
  if (spec === undefined) return [];
  const items = spec.items === null ? [] : (tables[spec.items] ?? []);
  return (tables[table] ?? []).map((row) => ({
    key: String(row[spec.key]),
    itemCount: items.filter((item) => item[spec.key] === row[spec.key]).length,
  }));
}

function everything(): Record<string, FoundRow[]> {
  return Object.fromEntries(Object.keys(PARENTS).map((table) => [table, asFound(table)]));
}

const demoRow = (key: string): FoundRow => ({ key, itemCount: 3 });

describe('#349 contagem das linhas da base lidas do banco', () => {
  it('sem linha de demonstração, a contagem é a do JSON em cada tabela', () => {
    const counts = kitCounts();
    const found = kitBaseCounts(everything());
    for (const table of Object.keys(PARENTS)) expect(found[table], table).toBe(counts[table]);
    for (const table of ['kit_nota_itens', 'kit_ordem_itens', 'kit_nota_lancada_itens', 'kit_recebimento_itens']) {
      if (counts[table] !== undefined) expect(found[table], table).toBe(counts[table]);
    }
  });

  it('as linhas de demonstração, e os itens delas, não entram na conta', () => {
    const all = everything();
    const withDemo = Object.fromEntries(
      Object.entries(all).map(([table, rows]) => [table, [...rows, demoRow(`OC-DM-${table}`), demoRow('9'.repeat(44))]]),
    );
    expect(kitBaseCounts(all).kit_notas).toBe(kitCounts().kit_notas);
    expect(kitBaseCounts(withDemo)).toEqual(kitBaseCounts(all));
  });

  it('uma linha da base que faltou no banco faz a contagem cair', () => {
    const all = everything();
    const missing = { ...all, kit_ordens: (all.kit_ordens ?? []).slice(1) };
    expect(kitBaseCounts(missing).kit_ordens).toBe((kitCounts().kit_ordens ?? 0) - 1);
  });
});
