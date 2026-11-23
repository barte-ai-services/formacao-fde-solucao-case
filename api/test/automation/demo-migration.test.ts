/**
 * #356 A migração do modo demonstração, da trava e das colunas novas de automation_runs, lida como texto: não há Postgres
 * local nesta lane (a prova contra o banco é a do Supabase na aplicação das migrações, supabase-base-do-kit.yml).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../../../supabase/migrations/', import.meta.url);
const FILE = '20261123100000_modo_demonstracao.sql';
const raw = readFileSync(new URL(FILE, DIR), 'utf8');
const sql = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');

describe('#356 migração do modo demonstração', () => { // ADR-002
  it('a versão é única e vem depois da última da main (20261122140000 é da #358)', () => { // ADR-002
    const versions = readdirSync(DIR).filter((n) => n.endsWith('.sql')).map((n) => n.split('_')[0]);
    expect(versions.filter((v) => v === FILE.split('_')[0])).toHaveLength(1);
    expect(Number(FILE.split('_')[0])).toBeGreaterThan(20261122140000);
  });

  it('#356/AC-1 demo_settings tem uma linha só, desligada por padrão, com quem mudou e quando', () => { // ADR-002
    expect(sql).toContain('create table public.demo_settings (');
    expect(sql).toMatch(/id boolean primary key default true/);
    expect(sql).toMatch(/constraint demo_settings_single_row check \(id\)/);
    expect(sql).toMatch(/enabled boolean not null default false/);
    expect(sql).toMatch(/changed_by text/);
    expect(sql).toMatch(/changed_at timestamptz not null default now\(\)/);
    expect(sql).toMatch(/insert into public\.demo_settings \(id\) values \(true\) on conflict \(id\) do nothing/);
  });

  it('#356/AC-3 a trava é uma linha com dono e validade, tomada e solta cada uma por uma função, numa requisição', () => { // ADR-002
    expect(sql).toContain('create table public.automation_lock (');
    expect(sql).toMatch(/owner text not null/);
    expect(sql).toMatch(/expires_at timestamptz not null/);
    expect(sql).toMatch(/constraint automation_lock_single_row check \(id\)/);
    expect(sql).toContain('create function public.take_automation_lock(p_owner text, p_valid_for_ms integer) returns boolean');
    expect(sql).toContain('create function public.release_automation_lock(p_owner text) returns boolean');
  });

  it('#356/AC-3 tomar a trava é atômico e usa o relógio do banco: só toma quem acha a linha vencida ou ausente', () => { // ADR-002
    expect(sql).toMatch(/on conflict \(id\) do update set owner = excluded\.owner, expires_at = excluded\.expires_at where l\.expires_at <= now\(\)/);
    expect(sql).toContain("now() + p_valid_for_ms * interval '1 millisecond'");
  });

  it('#356/AC-3 soltar apaga só a trava do próprio dono', () => { // ADR-002
    expect(sql).toMatch(/delete from public\.automation_lock where owner = p_owner/);
  });

  it('as funções só rodam para a chave secreta do Worker: ninguém mais toma a trava', () => { // ADR-002
    expect(sql).toMatch(/revoke execute on function public\.take_automation_lock\(text, integer\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.take_automation_lock\(text, integer\) to service_role/);
    expect(sql).toMatch(/revoke execute on function public\.release_automation_lock\(text\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.release_automation_lock\(text\) to service_role/);
  });

  it('a validade é justificada no comentário (a conta está em LOCK_TTL_MS)', () => {
    expect(raw).toMatch(/-- .*5 minutos.*LOCK_TTL_MS/);
  });

  it('#356/AC-3 automation_runs aceita skipped, guarda a origem (cron nas linhas antigas), o modo e os adiados', () => { // ADR-002
    expect(sql).toContain('alter table public.automation_runs');
    expect(sql).toContain('drop constraint automation_runs_status_check');
    expect(sql).toMatch(/add constraint automation_runs_status_check check \(status in \('ok', 'failed', 'skipped'\)\)/);
    expect(sql).toMatch(/add column origin text not null default 'cron'/);
    expect(sql).toMatch(/check \(origin in \('cron', 'manual'\)\)/);
    expect(sql).toMatch(/add column demo_enabled boolean not null default false/);
    expect(sql).toMatch(/add column deferred_steps text\[\] not null default '\{\}'/);
  });

  it('não cria índice: a tabela é pequena e a leitura das puladas não pede um (IDX-4, sem exceção a registrar)', () => { // ADR-002
    expect(sql).not.toMatch(/create (unique )?index/);
    expect(raw).not.toContain('automation_runs_skipped_idx');
  });

  it('#356/AC-2 demo_settings guarda a versão e o history das trocas, para o PATCH condicionado', () => { // ADR-002
    expect(sql).toMatch(/version integer not null default 1/);
    expect(sql).toMatch(/history jsonb not null default '\[\]'/);
  });

  it('#356/AC-3 automation_runs é append-only: ninguém, nem o service_role, atualiza, apaga ou trunca (PER-2)', () => { // ADR-002
    expect(sql).toContain('revoke update, delete, truncate on public.automation_runs from anon, authenticated, service_role;');
    // #356 O grant de insert e select do service_role (20261116100000) segue: a rodada grava e a tela lê.
    expect(sql).not.toMatch(/revoke (insert|select)/);
  });

  it('#356/AC-3 nenhum código da API atualiza ou apaga linha de automation_runs (o revoke não quebra ninguém)', () => {
    const root = new URL('../../src/', import.meta.url);
    const sources = (dir: URL): string[] =>
      readdirSync(dir).flatMap((name) => {
        if (name.endsWith('.ts')) return [new URL(name, dir).href];
        try {
          return sources(new URL(`${name}/`, dir));
        } catch {
          return [];
        }
      });
    const writers = sources(root).filter((file) => /\.(update|delete)\(\s*['"]automation_runs['"]/.test(readFileSync(new URL(file), 'utf8')));
    expect(sources(root).length).toBeGreaterThan(50);
    expect(writers).toEqual([]);
  });

  it('não toca em failed_steps nem em subrequests (migração 20261122130000)', () => { // ADR-002
    expect(sql).not.toMatch(/failed_steps|subrequests/);
  });

  it('RLS ligado nas duas tabelas novas e nenhuma política', () => { // ADR-002
    expect(sql).toContain('alter table public.demo_settings enable row level security');
    expect(sql).toContain('alter table public.automation_lock enable row level security');
    expect(sql).not.toMatch(/create policy/);
  });

  it('as funções ficam no public com o search_path fixo', () => { // ADR-002
    expect(sql.match(/set search_path = public/g)).toHaveLength(2);
  });
});
