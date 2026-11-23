import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #353: asserções sobre o texto da migração da devolução automática; o comportamento real roda em scripts/testar_migracoes_postgres.sh.
const DIR = new URL('../../../supabase/migrations/', import.meta.url);
const FILE = '20261123160000_demo_devolucao_automatica.sql';
const SQL = readFileSync(new URL(FILE, DIR), 'utf8');
const flat = SQL.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();

describe('#353/AC-3 o limite mora no banco, na linha do modo demonstração', () => {
  it('#353/AC-3: a versão é posterior à última migração que já existia e única', () => {
    const versions = readdirSync(DIR).filter((f) => f.endsWith('.sql')).map((f) => f.split('_')[0]);
    expect(versions.filter((v) => v === FILE.split('_')[0])).toHaveLength(1);
    expect(FILE.split('_')[0]! > '20261123150000').toBe(true);
  });

  it('#353/AC-3: demo_settings ganha o limite em centavos, 500000 (R$ 5.000,00) por padrão, nunca negativo (zero desliga)', () => {
    expect(flat).toContain(
      'alter table public.demo_settings add column auto_return_limit_cents integer not null default 500000 check (auto_return_limit_cents >= 0)',
    );
  });
});

describe('#353/AC-1 o pedido enviado sozinho é registrado com origin = demo e sent_by = automação', () => {
  it('#353/AC-1: o pedido ao fornecedor ganha a origem, obrigatória, base por padrão, só base ou demo', () => {
    expect(flat).toContain(
      "alter table public.outbox_supplier_emails add column origin text not null default 'base' check (origin in ('base', 'demo'))",
    );
  });

  it('#353/AC-1: a gravação em lote põe origin demo, sent_by automação e canal mock, e emite a nota e move a fila na mesma função', () => {
    expect(flat).toContain('create function public.demo_auto_return_send(p_batch jsonb) returns integer');
    expect(flat).toContain("'demo'");
    expect(flat).toContain("'automação'");
    expect(flat).toContain('insert into public.issued_return_notes');
    expect(flat).toContain("update public.outbox_return_notes set status = 'emitida'");
    expect(flat).toContain('emitted_by = ');
  });

  it('#353/AC-1: só notas da demonstração, e só pedido pendente na fila: o resto fica como está', () => {
    expect(flat).toContain("n.origin = 'demo'");
    expect(flat).toContain("q.status = 'pendente'");
  });
});

describe('#353/AC-2 o banco confere o limite e o modo de novo, na leitura e na gravação', () => {
  it('#353/AC-2: a leitura devolve o limite e nada com o modo desligado ou o limite zerado', () => {
    expect(flat).toContain('create function public.demo_auto_return_pending() returns jsonb');
    expect(flat).toContain('from public.demo_settings');
    expect(flat).toContain('auto_return_limit_cents');
  });

  it('#353/AC-2: a gravação recusa o que passa do limite (o valor da nota em centavos contra o limite do banco)', () => {
    expect(flat).toMatch(/\(e -> 'note' ->> 'total'\)::numeric \* 100 <= v_limit/);
  });
});

describe('#353 as funções seguem o padrão da #363', () => {
  it('roda com os direitos de quem chama: sem security definer, com o search_path fixo', () => {
    expect(flat).not.toContain('security definer');
    expect(flat).toContain('set search_path = public');
  });

  it('só o service_role executa as duas funções', () => {
    for (const fn of ['demo_auto_return_pending()', 'demo_auto_return_send(jsonb)']) {
      expect(flat).toContain(`revoke execute on function public.${fn} from public, anon, authenticated`);
      expect(flat).toContain(`grant execute on function public.${fn} to service_role`);
    }
  });

  it('expandir antes de usar: só cria colunas e funções, não apaga nem recria nada que existe', () => {
    expect(flat).not.toMatch(/drop (table|column|function)/);
  });
});
