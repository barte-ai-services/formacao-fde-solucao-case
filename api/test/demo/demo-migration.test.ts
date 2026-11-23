import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #349: asserções sobre o texto da migração do modo demonstração; o comportamento real roda em scripts/testar_migracoes_postgres.sh.
const FILE = '20261123110000_demo_origin_and_batch.sql';
const SQL = readFileSync(new URL(`../../../supabase/migrations/${FILE}`, import.meta.url), 'utf8');
const flat = SQL.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();

const TABLES_IN_FK_ORDER = [
  'kit_ordens',
  'kit_ordem_itens',
  'kit_notas_lancadas',
  'kit_nota_lancada_itens',
  'kit_notas',
  'kit_nota_itens',
  'kit_recebimentos',
  'kit_recebimento_itens',
  'kit_pagamentos',
];

describe('#349 kit_notas ganha a origem', () => {
  it('a coluna origin é obrigatória, vale base por padrão e só aceita base ou demo', () => {
    expect(flat).toContain(
      "alter table public.kit_notas add column origin text not null default 'base' check (origin in ('base', 'demo'))",
    );
  });
});

describe('#349 kit_insert_demo_batch grava o lote numa só chamada', () => {
  it('é uma função de um parâmetro jsonb que devolve inteiro, com o search_path fixo', () => {
    expect(flat).toContain('create function public.kit_insert_demo_batch(p_batch jsonb) returns integer');
    expect(flat).toContain('set search_path = public');
  });

  it('roda com os direitos de quem chama: sem security definer', () => {
    expect(flat).not.toContain('security definer');
  });

  it('só o service_role executa', () => {
    expect(flat).toContain('revoke execute on function public.kit_insert_demo_batch(jsonb) from public, anon, authenticated');
    expect(flat).toContain('grant execute on function public.kit_insert_demo_batch(jsonb) to service_role');
  });

  it('insere as nove tabelas na ordem das chaves estrangeiras, cada uma com on conflict do nothing', () => {
    const positions = TABLES_IN_FK_ORDER.map((t) => flat.indexOf(`insert into public.${t} (`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    const inserts = flat.match(/insert into public\./g) ?? [];
    const conflicts = flat.match(/on conflict do nothing/g) ?? [];
    expect(inserts).toHaveLength(TABLES_IN_FK_ORDER.length);
    expect(conflicts).toHaveLength(TABLES_IN_FK_ORDER.length);
  });

  it('nunca apaga nem atualiza: nenhum delete, update, truncate nem do update', () => {
    expect(flat).not.toMatch(/\bdelete from\b|\bupdate public\.|\btruncate\b|do update/);
  });

  it('toda nota gravada leva origin = demo, qualquer que seja o que o lote traga', () => {
    expect(flat).toContain("'demo'");
  });

  it('não cria tabela nem política: o RLS das tabelas do kit segue como está', () => {
    expect(flat).not.toContain('create table');
    expect(flat).not.toContain('create policy');
  });

  it('devolve quantas notas entraram, lidas do row_count do insert das notas', () => {
    expect(flat).toContain('get diagnostics');
    expect(flat).toContain('row_count');
  });
});
