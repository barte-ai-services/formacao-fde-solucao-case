/**
 * #295 A migração da versão da proposta, lida como texto. A prova contra um Postgres de verdade é o
 * scripts/testar_migracoes_postgres.sh (fora do `make check`: o CI não tem docker garantido).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../../../supabase/migrations/20261118100000_proposals_version.sql', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

describe('migração proposals_version (#295)', () => {
  it('#295/AC-1: a coluna version é inteira, obrigatória, e as linhas que já existem ficam com 1', () => {
    expect(sql).toMatch(/alter table public\.proposals\s+add column version integer not null default 1/);
  });

  it('#295/AC-1: o gatilho before update por linha incrementa sempre, sem ler o valor que o cliente mandou', () => {
    expect(sql).toMatch(/create trigger proposals_bump_version\s+before update on public\.proposals\s+for each row/);
    expect(sql).toMatch(/new\.version := old\.version \+ 1/);
    expect(sql).not.toMatch(/new\.version\s*[<>=]/);
  });

  it('#295: a função do gatilho tem search_path fixo e execução revogada de public, anon e authenticated', () => {
    expect(sql).toMatch(/create function public\.proposals_bump_version\(\)\s+returns trigger/);
    expect(sql).toMatch(/set search_path = public/);
    expect(sql).toMatch(/revoke execute on function public\.proposals_bump_version\(\) from public, anon, authenticated/);
  });
});
