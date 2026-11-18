/**
 * #304 A migração da função da decisão, lida como texto. A prova contra um Postgres de verdade é o
 * scripts/testar_migracoes_postgres.sh (fora do `make check`: o CI não tem docker garantido).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../../../supabase/migrations/20261118110000_save_approval_decision.sql', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

describe('migração save_approval_decision (#304)', () => {
  it('#304/AC-5: só o service_role executa: revoga de public, anon e authenticated e concede ao service_role', () => {
    expect(sql).toMatch(/revoke execute on function public\.save_approval_decision\([^)]*\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.save_approval_decision\([^)]*\) to service_role/);
    expect(sql).not.toMatch(/grant execute[^;]*to (public|anon|authenticated)/);
  });

  it('#304/AC-5: plpgsql com search_path fixo e sem security definer (roda com os direitos de quem chama)', () => {
    expect(sql).toMatch(/create function public\.save_approval_decision\(/);
    expect(sql).toMatch(/language plpgsql/);
    expect(sql).toMatch(/set search_path = public/);
    expect(sql).not.toMatch(/security definer/i);
  });

  it('#304/AC-1: devolve texto, trava a linha da proposta e grava as quatro tabelas', () => {
    expect(sql).toMatch(/returns text/);
    expect(sql).toMatch(/from public\.proposals[\s\S]*?for update/);
    expect(sql).toMatch(/insert into public\.approvals/);
    expect(sql).toMatch(/update public\.proposals/);
    expect(sql).toMatch(/update public\.titles/);
    expect(sql).toMatch(/update public\.invoices/);
  });

  it('#304/AC-3: a checagem de decisão já existente vem antes da de versão', () => {
    const decided = sql.indexOf("'already_decided'");
    const conflict = sql.indexOf("'version_conflict'");
    expect(decided).toBeGreaterThan(-1);
    expect(conflict).toBeGreaterThan(decided);
  });

  it('#304/AC-2: título ou nota sem linha levantam erro (desfazem a função inteira)', () => {
    expect(sql.match(/if not found then\s+raise exception/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('#304/AC-4: a versão lida nula levanta erro antes da trava, porque `<>` com nulo pularia a conferência', () => {
    const guard = sql.search(/if p_version is null then\s+raise exception/);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(sql.search(/for update/));
  });

  it('#304/AC-4: não grava approved_by, que é coluna gerada', () => {
    expect(sql).not.toMatch(/approved_by/);
  });
});
