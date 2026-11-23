// Linhas das tabelas kit_* montadas a partir de data/kit/*.json, como o scripts/load_kit.py grava (#59).
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;

function readKit(name: string): Json[] {
  return JSON.parse(readFileSync(new URL(`../../../data/kit/${name}.json`, import.meta.url), 'utf8')) as Json[];
}

/** #59 Separa o pai dos itens; cada item leva a chave do pai. */
function split(rows: Json[], parentKey: string): { parents: Json[]; children: Json[] } {
  const parents: Json[] = [];
  const children: Json[] = [];
  for (const { itens, ...parent } of rows) {
    parents.push(parent);
    for (const item of itens as Json[]) children.push({ [parentKey]: parent[parentKey], ...item });
  }
  return { parents, children };
}

export function kitTables(): Record<string, Json[]> {
  const ordens = split(readKit('ordens'), 'ordem_id');
  const notas = split(readKit('notas'), 'chave');
  const lancadas = split(readKit('notas_lancadas'), 'chave');
  const recebimentos = split(readKit('recebimentos'), 'recebimento_id');
  return {
    kit_fornecedores: readKit('fornecedores'),
    kit_produtos: readKit('produtos'),
    kit_ordens: ordens.parents,
    kit_ordem_itens: ordens.children,
    kit_notas: notas.parents,
    kit_nota_itens: notas.children,
    kit_notas_lancadas: lancadas.parents,
    kit_nota_lancada_itens: lancadas.children,
    kit_pagamentos: readKit('pagamentos'),
    kit_recebimentos: recebimentos.parents,
    kit_recebimento_itens: recebimentos.children,
  };
}

/** #59 Contagem de cada tabela no JSON do kit (AC-3). */
export function kitCounts(): Record<string, number> {
  return Object.fromEntries(Object.entries(kitTables()).map(([t, rows]) => [t, rows.length]));
}

export type FoundRow = { readonly key: string; readonly itemCount: number };

const BASE_KEY: Readonly<Record<string, { readonly key: string; readonly items: string | null }>> = {
  kit_notas: { key: 'chave', items: 'kit_nota_itens' },
  kit_ordens: { key: 'ordem_id', items: 'kit_ordem_itens' },
  kit_notas_lancadas: { key: 'chave', items: 'kit_nota_lancada_itens' },
  kit_pagamentos: { key: 'pagamento_id', items: null },
  kit_recebimentos: { key: 'recebimento_id', items: 'kit_recebimento_itens' },
};

/**
 * #349 Conta só as linhas da base entre as que o banco devolveu: a de demonstração entra nas mesmas tabelas e não está no JSON.
 * Pela chave primária do JSON: a linha cuja chave o JSON não tem não conta, nem os itens dela.
 */
export function kitBaseCounts(found: Readonly<Record<string, readonly FoundRow[]>>): Record<string, number> {
  const tables = kitTables();
  const counts: Record<string, number> = {};
  for (const [table, spec] of Object.entries(BASE_KEY)) {
    const wanted = new Set((tables[table] ?? []).map((row) => String(row[spec.key])));
    const base = (found[table] ?? []).filter((row) => wanted.has(row.key));
    counts[table] = base.length;
    if (spec.items !== null) counts[spec.items] = base.reduce((sum, row) => sum + row.itemCount, 0);
  }
  return counts;
}
