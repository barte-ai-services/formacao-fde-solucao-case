import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #156: asserções sobre o texto da migração e o registro dos modos: não há banco real nos testes (IDX-1 e o grant sem detector).

const SQL = readFileSync(new URL('../../../supabase/migrations/20261117160000_supplier_request.sql', import.meta.url), 'utf8');
const REGISTRY = readFileSync(new URL('../../../supabase/persistence-modes.yaml', import.meta.url), 'utf8');
const flat = SQL.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();
const section = (table: string): string => {
  const start = flat.indexOf(`create table public.${table} (`);
  return start < 0 ? '' : flat.slice(start, flat.indexOf('); ', start));
};

describe('#156 kit_fornecedores ganha o e-mail', () => { // ADR-002
  it('a coluna é anulável (a migração roda antes da carga) e tem a restrição de formato', () => { // ADR-002
    expect(flat).toContain('alter table public.kit_fornecedores add column email text');
    expect(flat).toMatch(/check \(email is null or email ~ '\^\[\^@\[:space:\]\]\+@\[\^@\[:space:\]\]\+\$'\)/);
  });
});

describe('#156 issued_return_notes: a nota emitida, única por devolução da fila', () => { // ADR-002
  const t = section('issued_return_notes');
  it('o id é a sequência da emissão, com o teto do domínio', () => { // ADR-002
    expect(t).toContain('id bigint generated always as identity (maxvalue 999999999)');
  });
  it('uma nota por devolução: a restrição única de queue_id, sem chave estrangeira para a fila', () => { // ADR-002
    expect(t).toContain('unique (queue_id)');
  });
  it('queue_id referencia outbox_return_notes só por identidade: nenhuma FK para ela, porque o reconferir a apaga', () => { // ADR-002
    expect(flat).not.toMatch(/references public\.outbox_return_notes/);
    expect(flat).not.toContain('_queue_fkey');
    expect(section('issued_return_notes')).toContain('queue_id bigint not null');
    expect(section('outbox_supplier_emails')).toContain('queue_id bigint not null');
  });
  it('a chave de acesso e o emitente não são colunas: saem da regra determinística', () => { // ADR-002
    expect(t).not.toMatch(/[ (,]access_key /);
    expect(t).not.toContain('issuer');
  });
  it('é append-only: update, delete e truncate revogados dos três papéis', () => { // ADR-002
    expect(flat).toContain('revoke update, delete, truncate on public.issued_return_notes from anon, authenticated, service_role');
  });
  it('a nota guardada é um objeto', () => { // ADR-002
    expect(t).toContain("check (jsonb_typeof(note) = 'object')");
  });
});

describe('#156 outbox_supplier_emails: um pedido aberto por nota de origem e tipo', () => { // ADR-002
  it('o índice único parcial tem o predicado exato dos estados abertos', () => { // ADR-002
    expect(flat).toContain(
      "create unique index outbox_supplier_emails_open_key on public.outbox_supplier_emails (invoice_access_key, request_type) where status in ('draft', 'sent', 'send_failed')",
    );
  });
});

describe('#156 outbox_supplier_emails guarda o pedido, o envio e o histórico', () => { // ADR-002
  const t = section('outbox_supplier_emails');
  it('as colunas do pedido: destinatário, assunto, corpo, o que pedimos, anexos, prazo, modelo e motivos', () => { // ADR-002
    for (const column of [
      'recipient text not null',
      'subject text not null',
      'body text not null',
      'asks jsonb not null',
      'attachments jsonb not null',
      'due_on date not null',
      'drafted_on date not null',
      'model text not null',
      'send_failure_reason text',
      'discard_reason text',
      'channel text',
      'provider_message_id text',
      'sent_by text',
      'sent_at timestamptz',
      'discarded_by text',
      'discarded_at timestamptz',
    ]) {
      expect(t, column).toContain(column);
    }
  });
  it('upsert com histórico: versão, histórico em jsonb e a trava do envio com prazo', () => { // ADR-002
    expect(t).toContain('version integer not null default 1');
    expect(t).toContain("history jsonb not null default '[]'");
    expect(t).toContain("check (jsonb_typeof(history) = 'array')");
    expect(t).toContain('send_claim uuid');
    expect(t).toContain('send_claimed_at timestamptz');
    expect(t).toContain('(send_claim is null) = (send_claimed_at is null)');
  });
  it('os estados e o canal são enums por check', () => { // ADR-002
    expect(t).toContain("check (status in ('draft', 'sent', 'send_failed', 'discarded'))");
    expect(t).toContain("check (channel in ('mock', 'resend'))");
    expect(t).toContain("check (request_type in ('return_note'))");
  });
  it('as coerências do estado: enviado carrega o carimbo, descartado carrega o motivo, falha carrega o motivo', () => { // ADR-002
    expect(t).toContain('(status = \'sent\') = (sent_by is not null and sent_at is not null and channel is not null and provider_message_id is not null)');
    expect(t).toContain("(status = 'discarded') = (discard_reason is not null)");
    expect(t).toContain("status <> 'send_failed' or send_failure_reason is not null");
  });
  it('ADR-005: só os atos humanos têm quem e quando; não há created_by nem updated_by', () => { // ADR-002
    expect(t).not.toContain('created_by');
    expect(t).not.toContain('updated_by');
    expect(t).toContain('created_at timestamptz not null default now()');
    expect(t).toContain('updated_at timestamptz not null default now()');
  });
  it('nenhum delete e nenhum drop: o fim do pedido é descartado, com motivo', () => { // ADR-002
    expect(flat.replace(/revoke [^;]*;/g, '')).not.toMatch(/\bdelete\b/);
    expect(flat).not.toContain('drop ');
  });
});

describe('#156 a migração segue as convenções do projeto', () => { // ADR-002
  it('RLS ligado nas duas tabelas novas e nenhuma política', () => { // ADR-002
    expect(flat).toContain('alter table public.issued_return_notes enable row level security');
    expect(flat).toContain('alter table public.outbox_supplier_emails enable row level security');
    expect(flat).not.toContain('create policy');
    expect(flat).not.toContain('disable row level security');
  });

  it('só o parcial e os dois de leitura (Q6 e Q7) são índices novos: nenhum índice sem consulta', () => { // ADR-002
    expect(flat.match(/create (unique )?index/g)).toHaveLength(3);
    expect(flat).toContain('create index outbox_supplier_emails_latest on public.outbox_supplier_emails (invoice_access_key, request_type, id desc)');
    expect(flat).toContain('create index outbox_supplier_emails_status on public.outbox_supplier_emails (status, id desc)');
  });

  it('cada linha de comentário leva o ponteiro de uma issue ou ADR; cada enum leva -- ADR-002', () => { // ADR-002
    for (const line of SQL.split('\n')) {
      const comment = line.indexOf('--');
      if (comment >= 0) expect(line.slice(comment), line).toMatch(/#\d+|ADR-\d+/);
      if (/check \((status|channel|request_type) in/.test(line)) expect(line, line).toContain('-- ADR-002');
    }
  });
});

describe('#156 o registro dos modos de persistência', () => { // ADR-002
  it('declara as três tabelas desta camada, cada uma no seu modo', () => { // ADR-002
    expect(REGISTRY).toMatch(/issued_return_notes:\s*\n\s*mode: append-only/);
    expect(REGISTRY).toMatch(/outbox_supplier_emails:\s*\n\s*mode: upsert-with-history/);
    expect(REGISTRY).toMatch(/kit_fornecedores:[^\n]*\n\s*mode: ephemeral/);
  });
});
