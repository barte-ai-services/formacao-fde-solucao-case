// #311 AC-4 A migração de backfill, lida como texto: não há Postgres no `make check` (a prova num banco de verdade é
// #311 scripts/testar_migracoes_postgres.sh, que o CI não roda). Aqui só o que dá para garantir sem banco: o formato que a torna idempotente
// #311 e os mesmos critérios de `needsDossier`.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../../../supabase/migrations/', import.meta.url);
const names = (): string[] => readdirSync(DIR);
const read = (suffix: string): string => {
  const name = names().find((f) => f.endsWith(suffix));
  if (!name) throw new Error(`migração ${suffix} não encontrada`);
  return readFileSync(new URL(name, DIR), 'utf8');
};

describe('#311/AC-4 o backfill do dossiê', () => {
  const backfill = read('_dossier_backfill.sql');
  const status = read('_dossier_requests_status.sql');

  it('enfileira como pending, trigger event e requested_by backfill, sem finished_at', () => {
    expect(backfill).toMatch(/insert into public\.dossier_requests \(input_key, requested_by, requested_at, finished_at, trigger, status\)/);
    expect(backfill).toMatch(/select p\.invoice_access_key, 'backfill', now\(\), null, 'event', 'pending'/);
  });

  it('espelha needsDossier: aguardando_aprovacao, rota que não é a regra, sem aprovação e sem dossiê ok', () => {
    expect(backfill).toContain("p.state = 'aguardando_aprovacao'");
    expect(backfill).toContain("p.approval_level <> 'regra'");
    expect(backfill).toMatch(/not exists \(select 1 from public\.approvals a where a\.proposal_id = p\.id\)/);
    expect(backfill).toMatch(/s\.task = 'dossier' and s\.input_key = p\.invoice_access_key and s\.status = 'ok'/);
  });

  it('é idempotente: índice único parcial em input_key onde status = pending e on conflict do nothing', () => {
    expect(status).toMatch(/create unique index \w+ on public\.dossier_requests \(input_key\) where status = 'pending'/);
    expect(backfill).toMatch(/on conflict \(input_key\) where status = 'pending' do nothing/);
  });

  it('a migração do estado traz os quatro status, o conjunto fechado de motivos e fecha as linhas antigas em done', () => {
    expect(status).toContain("check (status in ('pending', 'running', 'done', 'error'))");
    expect(status).toContain("'no_credentials', 'rate_limited', 'auth_refused', 'claude_failed', 'storage_failed', 'not_needed'");
    expect(status).toContain("update public.dossier_requests set status = 'done' where finished_at is not null");
  });

  it('as versões são únicas e posteriores à última da main (20261118110000), com o estado antes do backfill', () => {
    const versions = names().map((f) => f.split('_')[0]);
    expect(new Set(versions).size).toBe(versions.length);
    const mine = names().filter((f) => f.includes('dossier_requests_status') || f.includes('dossier_backfill'));
    expect(mine.map((f) => f.split('_')[0])).toEqual(['20261122100000', '20261122110000']);
  });
});
