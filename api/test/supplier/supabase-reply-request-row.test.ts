import { describe, expect, it } from 'vitest';
import { SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { followUpOf, followUpSummary, lastState, type FollowUpColumns } from '../../src/supplier/supabase-reply-request-row.js';
import { GOOD_FOLLOW_UP } from './reply-doubles.js';

// #157 (ADR-003): o teste de supabase-reply-request-row.ts ao lado do espelho: a cobrança nas colunas, o estado do histórico e o resumo.

const empty: FollowUpColumns = {
  follow_up_draft: null,
  follow_up_rejection: null,
  follow_up_claimed_at: null,
  follow_up_sent_by: null,
  follow_up_sent_at: null,
  follow_up_channel: null,
  follow_up_provider_message_id: null,
  follow_up_failure: null,
};

const attempt = (run: () => unknown): unknown => {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
};

describe('#157 followUpOf: o estado da cobrança nas colunas', () => {
  it('sem carimbo, sent é null', () => {
    expect(followUpOf(empty)).toEqual({ draft: null, dueOn: null, rejection: null, sent: null, failure: null });
  });

  it('com o carimbo completo, sent leva quem, quando, o canal e o identificador', () => {
    const row: FollowUpColumns = { ...empty, follow_up_sent_by: 'ana@jachegou.example', follow_up_sent_at: '2026-11-20T16:00:00Z', follow_up_channel: 'mock', follow_up_provider_message_id: 'mock-9' };
    expect(followUpOf(row).sent).toEqual({ by: 'ana@jachegou.example', at: new Date('2026-11-20T16:00:00Z'), channel: 'mock', providerMessageId: 'mock-9' });
  });

  it('com o carimbo parcial, sent é null (a migração garante as quatro partes juntas)', () => {
    expect(followUpOf({ ...empty, follow_up_sent_at: '2026-11-20T16:00:00Z', follow_up_sent_by: 'ana@jachegou.example' }).sent).toBeNull();
  });

  it('com um instante fora do formato, lança o erro de formato nomeado e sem o valor', () => {
    const row: FollowUpColumns = { ...empty, follow_up_sent_by: 'ana', follow_up_sent_at: 'ontem', follow_up_channel: 'mock', follow_up_provider_message_id: 'mock-9' };
    const failure = attempt(() => followUpOf(row));
    expect(failure).toBeInstanceOf(SupabaseRestError);
    expect(failure).toMatchObject({ operation: 'parse', table: 'outbox_supplier_emails' });
    expect((failure as Error).message).not.toContain('ontem');
  });

  it('o rascunho e a falha vêm das colunas', () => {
    const state = followUpOf({ ...empty, follow_up_draft: GOOD_FOLLOW_UP, follow_up_failure: 'mailbox_full' });
    expect(state).toMatchObject({ draft: GOOD_FOLLOW_UP, failure: 'mailbox_full' });
  });
});

describe('#157 lastState: o estado da última entrada do histórico, copiado', () => {
  it('copia o state da última entrada', () => {
    expect(lastState([{ state: { status: 'draft' } }, { state: { status: 'sent' } }])).toEqual({ status: 'sent' });
  });

  it('sem entrada, ou com a última sem state, ou com valor que não é objeto, é null', () => {
    expect(lastState([])).toBeNull();
    expect(lastState([{ action: 'x' }])).toBeNull();
    expect(lastState(['x'])).toBeNull();
    expect(lastState([null])).toBeNull();
  });
});

describe('#157 followUpSummary: nomes e marcas, nunca o texto do rascunho', () => {
  it('resume o estado sem o texto', () => {
    const summary = followUpSummary({ ...empty, follow_up_draft: GOOD_FOLLOW_UP, follow_up_claimed_at: '2026-11-20T16:00:00Z' });
    expect(summary).toEqual({ drafted: true, rejection: null, claimed: true, sent: false, failure: null });
    expect(JSON.stringify(summary)).not.toContain(GOOD_FOLLOW_UP.subject);
    expect(JSON.stringify(summary)).not.toContain(GOOD_FOLLOW_UP.body);
  });

  it('leva o motivo da recusa e o da falha, que são fechados', () => {
    expect(followUpSummary({ ...empty, follow_up_rejection: 'number_mismatch: body', follow_up_failure: 'mailbox_full' })).toMatchObject({
      rejection: 'number_mismatch: body',
      failure: 'mailbox_full',
    });
  });
});
