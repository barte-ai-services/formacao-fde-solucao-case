import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #35: asserções sobre o texto da migração e o registro dos modos. Elas valem sem banco; o mesmo SQL também foi aplicado
// #35: num PostgreSQL de verdade na construção da camada (o relatório da entrega diz como), e esta é a rede que fica no gate.

const SQL = readFileSync(new URL('../../../supabase/migrations/20261117170000_inbox_supplier_messages.sql', import.meta.url), 'utf8');
const REGISTRY = readFileSync(new URL('../../../supabase/persistence-modes.yaml', import.meta.url), 'utf8');
const flat = SQL.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();
const section = (table: string): string => {
  const start = flat.indexOf(`create table public.${table} (`);
  return start < 0 ? '' : flat.slice(start, flat.indexOf('); ', start));
};

describe('#35/AC-1 inbox_supplier_messages: a caixa de entrada mock', () => { // ADR-002
  const t = section('inbox_supplier_messages');
  it('a mensagem é do pedido (FK) e a identidade na origem é única, para o script rodar de novo sem duplicar (#4/AC-7)', () => { // ADR-002
    expect(t).toContain('foreign key (request_id) references public.outbox_supplier_emails (id)');
    expect(t).toContain('unique (source_message_id)');
    expect(t).toContain('unique (id, request_id)');
  });
  it('o remetente não se chama from (palavra reservada) e os anexos são só metadado', () => { // ADR-002
    expect(t).toContain('from_address text not null');
    expect(t).toContain("attachments_meta jsonb not null default '[]'");
    expect(t).toContain("check (jsonb_typeof(attachments_meta) = 'array')");
  });
  it('read_status tem o conjunto fechado, e o erro guarda só o motivo fechado `<motivo>: <campo>`', () => { // ADR-002
    expect(t).toContain("check (read_status in ('pending', 'ok', 'error'))");
    expect(t).toContain("read_error ~ '^[a-z_]+: [a-z_]+$'");
  });
  it('a coerência: pendente não tem carimbo, erro tem motivo', () => { // ADR-002
    expect(t).toContain("(read_status = 'pending') = (read_status_at is null)");
    expect(t).toContain("(read_status = 'error') = (read_error is not null)");
  });
  it('a transição guarda quem a fez (PER-3): read_status_by, nulo só enquanto pendente', () => { // ADR-002
    expect(t).toContain('read_status_by text');
    expect(t).toContain("(read_status = 'pending') = (read_status_by is null)");
  });
  it('a mensagem é imutável: só as quatro colunas da transição podem ser atualizadas, e nada é apagado', () => { // ADR-002
    expect(flat).toContain('revoke update, delete, truncate on public.inbox_supplier_messages from anon, authenticated, service_role');
    expect(flat).toContain('grant update (read_status, read_error, read_status_at, read_status_by) on public.inbox_supplier_messages to service_role');
  });
  it('o índice parcial das pendentes serve a listagem', () => { // ADR-002
    expect(flat).toContain("create index inbox_supplier_messages_pending_idx on public.inbox_supplier_messages (id) where read_status = 'pending'");
  });
  it('RLS ligado e nenhuma política', () => { // ADR-002
    expect(flat).toContain('alter table public.inbox_supplier_messages enable row level security');
    expect(flat).not.toContain('create policy');
  });
});

describe('#35/AC-1 supplier_reply_readings: as leituras, um log append-only', () => { // ADR-002
  const t = section('supplier_reply_readings');
  it('uma leitura por mensagem, e a mensagem é do mesmo pedido (FK composta)', () => { // ADR-002
    expect(t).toContain('constraint supplier_reply_readings_message_key unique (message_id)');
    expect(t).toContain('foreign key (message_id, request_id) references public.inbox_supplier_messages (id, request_id)');
    expect(t).toContain('foreign key (request_id) references public.outbox_supplier_emails (id)');
  });
  it('um no_reply por pedido: o índice único parcial com o predicado exato', () => { // ADR-002
    expect(flat).toContain(
      'create unique index supplier_reply_readings_one_no_reply on public.supplier_reply_readings (request_id) where message_id is null',
    );
  });
  it('o índice do embutido serve o pedido na ordem da projeção', () => { // ADR-002
    expect(flat).toContain('on public.supplier_reply_readings (request_id, message_id desc nulls last)');
  });
  it('os conjuntos fechados de reply_outcome e next_step', () => { // ADR-002
    expect(t).toContain("reply_outcome in ('fulfilled', 'partially_fulfilled', 'refused', 'needs_information', 'no_reply')");
    expect(t).toContain("next_step in ('close', 'confirm_document', 'answer_supplier', 'follow_up')");
  });
  it('as regras do domínio repetidas no banco: no_reply só da varredura, fulfilled com documento só confirma, close só de fulfilled', () => { // ADR-002
    expect(t).toContain("(reply_outcome = 'no_reply') = (message_id is null)");
    expect(t).toContain("reply_outcome <> 'no_reply' or next_step = 'follow_up'");
    expect(t).toContain("reply_outcome <> 'fulfilled' or supplier_document is null or next_step = 'confirm_document'");
    expect(t).toContain("next_step <> 'close' or reply_outcome = 'fulfilled'");
  });
  it('não copia a regra da PR #40 que impediria o fulfilled sem documento de fechar', () => { // ADR-002
    expect(t).not.toContain("reply_outcome <> 'fulfilled' or next_step = 'confirm_document'");
  });
  it('nenhuma coluna aponta para proposta, título ou valor em risco (#4/AC-6)', () => { // ADR-002
    expect(t).not.toMatch(/proposal|title|amount|risk|decision/);
  });
  it('é append-only: update, delete e truncate revogados dos três papéis; RLS ligado e nenhuma política', () => { // ADR-002
    expect(flat).toContain('revoke update, delete, truncate on public.supplier_reply_readings from anon, authenticated, service_role');
    expect(flat).toContain('alter table public.supplier_reply_readings enable row level security');
  });
});

describe('#35/AC-3 outbox_supplier_emails ganha as colunas da cobrança (sem tabela nova do pedido)', () => { // ADR-002
  const start = flat.indexOf('alter table public.outbox_supplier_emails');
  const t = flat.slice(start, flat.indexOf('; ', start));
  it('as colunas follow_up_* são anuláveis e sem default, num único alter table', () => { // ADR-002
    for (const column of [
      'follow_up_draft jsonb',
      'follow_up_rejection text',
      'follow_up_claimed_at timestamptz',
      'follow_up_claim uuid',
      'follow_up_sent_by text',
      'follow_up_sent_at timestamptz',
      'follow_up_channel text',
      'follow_up_provider_message_id text',
      'follow_up_failure text',
    ]) {
      expect(t).toContain(`add column ${column}`);
    }
    expect(t).not.toMatch(/add column follow_up_\w+ \w+ (not null|default)/);
  });
  it('os formatos fechados da recusa e da falha, e o canal fechado', () => { // ADR-002
    expect(t).toContain("follow_up_rejection ~ '^[a-z_]+: [a-z_]+$'");
    expect(t).toContain("follow_up_failure ~ '^[a-z][a-z0-9_]{0,39}$'");
    expect(t).toContain("follow_up_channel in ('mock', 'resend')");
  });
  it('a coerência: rascunho ou recusa, reivindicação exige rascunho, envio mantém a reivindicação e limpa a falha', () => { // ADR-002
    expect(t).toContain('follow_up_draft is null or follow_up_rejection is null');
    expect(t).toContain('follow_up_claimed_at is null or follow_up_draft is not null');
    expect(t).toContain('(follow_up_claim is null) = (follow_up_claimed_at is null)'); // #35 a ficha da reivindicação anda junto com o prazo
    expect(t).toContain('follow_up_sent_at is null or follow_up_claimed_at is not null');
    expect(t).toContain('follow_up_sent_at is null or follow_up_failure is null');
    expect(t).toMatch(/status = 'sent' or \(follow_up_draft is null and follow_up_rejection is null/);
    expect(t).toContain('follow_up_claimed_at is null and follow_up_claim is null and follow_up_sent_at is null'); // #35 só pedido enviado tem ficha
  });
  it('nenhuma tabela nova representa o pedido', () => { // ADR-002
    expect(flat).not.toMatch(/create table public\.(supplier_requests|supplier_request)\b/);
  });
});

describe('#35 o registro dos modos', () => { // ADR-002
  it('declara as duas tabelas novas e a extensão da #12', () => { // ADR-002
    expect(REGISTRY).toContain('inbox_supplier_messages:');
    expect(REGISTRY).toContain('supplier_reply_readings:');
    expect(REGISTRY).toContain('extended_by: "#35"');
    expect(REGISTRY).toMatch(/supplier_reply_readings:\s+mode: append-only/);
  });
});

describe('#35 o texto da migração segue o projeto', () => { // ADR-002
  it('o carimbo é o último da árvore e as comentadas de enum levam ADR-002', () => { // ADR-002
    expect(SQL).toMatch(/-- ADR-002/);
    expect(SQL).toMatch(/-- #35/);
    expect(SQL).toMatch(/-- #4\/AC-\d/);
  });
});
