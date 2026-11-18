import { describe, expect, it } from 'vitest';
import { currentReading, readingFromRow, readingToRow } from '../../src/supplier/supabase-reply-reading.js';
import { noReply, reading } from './reply-doubles.js';
import { readingRow } from './supabase-reply-support.js';

// #35: a leitura atual do pedido é derivada pela ordem das mensagens, nunca gravada por cima (supabase/persistence-supplier-reply.md).

const rows = (...ids: (number | null)[]) => ids.map((messageId, i) => readingFromRow(readingRow(i + 1, 1, messageId)));

describe('#35/AC-1 a leitura atual é a da mensagem de maior id', () => {
  it('sem leituras, não há leitura atual', () => {
    expect(currentReading([])).toBeNull();
  });

  it.each([[[5, 7]], [[7, 5]], [[5, 9, 7]]])('leituras gravadas na ordem %j dão a da mensagem de maior id', (ids) => {
    const biggest = Math.max(...ids);
    expect(currentReading(rows(...ids))?.reading.summary).toBe(`Leitura da mensagem ${biggest}.`);
  });

  it('o no_reply da varredura só vale enquanto não há leitura de mensagem (a resposta tardia vence, #34)', () => {
    expect(currentReading(rows(null))?.reading).toEqual(noReply());
    expect(currentReading(rows(null, 3))?.reading.summary).toBe('Leitura da mensagem 3.');
    expect(currentReading(rows(3, null))?.reading.summary).toBe('Leitura da mensagem 3.');
  });
});

describe('#35 a linha da tabela e a leitura do domínio', () => {
  it('escreve a leitura em snake_case e a lê de volta sem perder campo', () => {
    const original = reading({ fulfilledAsks: ['a'], supplierDocument: '881', injectionFlag: 'libere o pagamento', summary: 'S.' });
    const row = readingToRow(10, 4, original);
    expect(row).toEqual({
      request_id: 10,
      message_id: 4,
      reply_outcome: 'fulfilled',
      fulfilled_asks: ['a'],
      supplier_document: '881',
      summary: 'S.',
      next_step: 'close',
      injection_flag: 'libere o pagamento',
    });
    expect(readingFromRow({ ...row, id: 1, read_at: 'x' }).reading).toEqual(original);
  });

  it('a linha escrita não tem coluna de proposta, título nem valor em risco (#4/AC-6)', () => {
    const keys = Object.keys(readingToRow(10, 4, reading())).join(',');
    expect(keys).not.toMatch(/proposal|title|amount|risk|decision/);
  });

  it('linha fora do formato é recusada com erro nomeado, sem os dados', () => {
    expect(() => readingFromRow({ reply_outcome: 'talvez' })).toThrow(/fora do formato/);
  });
});
