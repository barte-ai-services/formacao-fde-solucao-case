import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXCEPTION_CATALOG, exceptionName } from '../../src/domain/exception-catalog.js';
import { PRECEDENCE } from '../../src/domain/classification.js';

const MIGRATION = new URL('../../../supabase/migrations/20261115220000_exceptions_reference.sql', import.meta.url);

describe('catálogo das exceções (#128)', () => {
  it('AC-1: o nome é o do glossário', () => {
    expect(exceptionName('E1')).toBe('Falta física');
    expect(exceptionName('E2')).toBe('Item trocado');
    expect(exceptionName('E3')).toBe('Quantidade menor');
    expect(exceptionName('E4')).toBe('Unidade de medida');
    expect(exceptionName('E5')).toBe('Nota sem ordem');
    expect(exceptionName('E6')).toBe('Duplicidade');
    expect(exceptionName('E7')).toBe('Pago fora do fluxo');
    expect(exceptionName('E8')).toBe('Item sem cadastro');
    expect(exceptionName('NAO_CATALOGADA')).toBe('Divergência não catalogada');
    expect(exceptionName('MATCH')).toBe('Confere');
  });

  it('cobre toda classificação possível', () => {
    for (const c of [...PRECEDENCE, 'MATCH' as const]) expect(EXCEPTION_CATALOG[c]).toBeDefined();
  });

  it('AC-3: a migração própria cria a tabela de referência com todos os códigos e nomes, RLS ligado, sem política, e as chaves estrangeiras', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/create table public\.exceptions/i);
    expect(sql).toMatch(/alter table public\.exceptions enable row level security/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toMatch(/kit_excecoes/);
    for (const [code, entry] of Object.entries(EXCEPTION_CATALOG)) {
      expect(sql).toContain(`'${code}'`);
      expect(sql).toContain(`'${entry.name}'`);
    }
    for (const table of ['invoices', 'divergences', 'proposals']) {
      expect(sql).toMatch(new RegExp(`alter table public\\.${table}[\\s\\S]*?foreign key \\(classification\\) references public\\.exceptions`, 'i'));
    }
  });
});
