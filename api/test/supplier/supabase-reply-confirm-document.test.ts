import { describe, expect, it } from 'vitest';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import type { DocumentConfirmation } from '../../src/domain/index.js';
import { supabaseReplyRequestStore } from '../../src/supplier/supabase-reply-store.js';
import { NOW } from './reply-doubles.js';
import { OUTBOX, READINGS, readingRow, replyHarness, sentRow } from './supabase-reply-support.js';

// #157: a confirmação do documento sobre o PostgREST falso, sem migração: ela é uma entrada `document_confirmed` do `history` da linha
// #157: do pedido (outbox_supplier_emails), gravada num único PATCH guardado pela versão lida, como as gravações da cobrança (#157, #157).
// Os nomes de `it` seguem o ADR-004.

const ANA = 'ana@jachegou.example';
const BETO = 'beto@jachegou.example';
const AT = new Date('2026-11-21T10:00:00Z');
const confirmation = (by = ANA, document = '881'): DocumentConfirmation => ({ document, by, at: AT });
const TO_CONFIRM = { replyOutcome: 'fulfilled', supplierDocument: '881', nextStep: 'confirm_document' } as const;

const setup = (outbox: Record<string, unknown>[] = [sentRow(1)], messageDocument = '881') => {
  const h = replyHarness({ [OUTBOX]: outbox, [READINGS]: [readingRow(1, 1, 5, { ...TO_CONFIRM, supplierDocument: messageDocument })] });
  return { ...h, store: supabaseReplyRequestStore(h.rest, { now: () => NOW }) };
};
const outboxRow = (fake: ReturnType<typeof replyHarness>['fake'], id = 1) => fake.rows(OUTBOX).find((r) => r.id === id) as Record<string, unknown>;
const lastEntry = (row: Record<string, unknown>) => (row.history as Record<string, unknown>[]).at(-1) as Record<string, unknown>;

describe('#157 confirmDocument: um PATCH guardado, com a entrada document_confirmed no histórico (ADR-005)', () => {
  it('#157: grava o documento, quem e quando numa entrada do histórico e soma 1 à versão; nenhuma coluna da linha muda', async () => {
    const { fake, store } = setup();
    const before = { ...outboxRow(fake) };
    expect(await store.confirmDocument(1, confirmation())).toBe('recorded');
    const row = outboxRow(fake);
    expect(row.version).toBe(4);
    expect(lastEntry(row)).toMatchObject({ version: 4, at: AT.toISOString(), by: ANA, action: 'document_confirmed', document: '881', state: { status: 'sent' } });
    expect(row.history).toHaveLength((before.history as unknown[]).length + 1);
    const { version: _v, history: _h, updated_at: _u, ...untouched } = row;
    const { version: _bv, history: _bh, updated_at: _bu, ...untouchedBefore } = before;
    expect(untouched).toEqual(untouchedBefore);
  });

  it('#157: é um único PATCH, filtrado pela versão lida e pelo estado sent, com o corpo só em version, updated_at e history', async () => {
    const { fake, store } = setup();
    await store.confirmDocument(1, confirmation());
    const patches = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(decodeURIComponent(patches[0]?.url ?? '')).toContain('version=eq.3');
    expect(patches[0]?.url).toContain('status=eq.sent');
    expect(Object.keys(patches[0]?.body as object).sort()).toEqual(['history', 'updated_at', 'version']);
    expect(fake.requests.filter((r) => r.method !== 'GET' && !r.url.includes(OUTBOX))).toEqual([]);
  });

  it('#157: depois de gravada, o pedido lido traz a confirmação do documento da leitura: o documento, quem e quando', async () => {
    const { store } = setup();
    await store.confirmDocument(1, confirmation());
    expect((await store.get(1))?.documentConfirmation).toEqual(confirmation());
    expect((await store.listSent())[0]?.documentConfirmation).toEqual(confirmation());
  });

  it('#157: sem confirmação gravada o pedido lido traz documentConfirmation nulo', async () => {
    const { store } = setup();
    expect((await store.get(1))?.documentConfirmation).toBeNull();
  });

  it('#157: a confirmação já gravada do mesmo documento volta already_confirmed e não grava', async () => {
    const { fake, store } = setup();
    await store.confirmDocument(1, confirmation());
    expect(await store.confirmDocument(1, confirmation(BETO))).toBe('already_confirmed');
    expect(fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    expect(outboxRow(fake).version).toBe(4);
    expect((await store.get(1))?.documentConfirmation?.by).toBe(ANA);
  });

  it('#157: duas confirmações ao mesmo tempo, na mesma versão: uma grava e a outra volta already_confirmed', async () => {
    const { fake, store } = setup();
    const results = await Promise.all([store.confirmDocument(1, confirmation(ANA)), store.confirmDocument(1, confirmation(BETO))]);
    expect([...results].sort()).toEqual(['already_confirmed', 'recorded']);
    expect(outboxRow(fake).version).toBe(4);
    expect((outboxRow(fake).history as Record<string, unknown>[]).filter((e) => e.action === 'document_confirmed')).toHaveLength(1);
  });

  it('#157: a outra confirmação termina entre a primeira leitura e a gravação: quem chega depois volta already_confirmed, com 1 entrada, a da primeira pessoa', async () => {
    const h = replyHarness({ [OUTBOX]: [sentRow(1)], [READINGS]: [readingRow(1, 1, 5, TO_CONFIRM)] });
    const other = supabaseReplyRequestStore(h.rest, { now: () => NOW });
    let interleaved = false;
    const racing = new SupabaseRest({
      url: 'https://projeto.test',
      secretKey: 'sb_secret_teste',
      fetch: async (input, init) => {
        const response = await h.fake.fetch(input, init);
        if (!interleaved && init?.method === 'GET' && String(input).includes(OUTBOX)) {
          interleaved = true; // #157: B termina inteira depois da primeira leitura de A (versão 3, sem confirmação) e antes da gravação de A
          expect(await other.confirmDocument(1, confirmation(ANA))).toBe('recorded');
        }
        return response;
      },
    });
    const store = supabaseReplyRequestStore(racing, { now: () => NOW });
    expect(await store.confirmDocument(1, confirmation(BETO))).toBe('already_confirmed');
    const confirmations = (outboxRow(h.fake).history as Record<string, unknown>[]).filter((e) => e.action === 'document_confirmed');
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]?.by).toBe(ANA);
    expect(outboxRow(h.fake).version).toBe(4);
  });

  it('#157: a versão que andou por outra gravação entre a leitura e o PATCH volta stale, e nada é gravado', async () => {
    const h = replyHarness({ [OUTBOX]: [sentRow(1)], [READINGS]: [readingRow(1, 1, 5, TO_CONFIRM)] });
    let moved = false;
    const racing = new SupabaseRest({
      url: 'https://projeto.test',
      secretKey: 'sb_secret_teste',
      fetch: (input, init) => {
        if (!moved && init?.method === 'PATCH') {
          moved = true; // #157: outra gravação da linha entra depois da leitura e antes do PATCH
          Object.assign(outboxRow(h.fake), { version: 4 });
        }
        return h.fake.fetch(input, init);
      },
    });
    const store = supabaseReplyRequestStore(racing, { now: () => NOW });
    expect(await store.confirmDocument(1, confirmation())).toBe('stale');
    expect((outboxRow(h.fake).history as Record<string, unknown>[]).some((e) => e.action === 'document_confirmed')).toBe(false);
  });

  it('#157: o pedido que não existe lança, como as outras gravações', async () => {
    const { store } = setup();
    await expect(store.confirmDocument(9, confirmation())).rejects.toThrow();
  });
});

describe('#157 uma leitura nova não apaga a confirmação: ela vale para o documento citado', () => {
  it('#157: a leitura nova com o mesmo documento mantém a confirmação', async () => {
    const { fake, store } = setup();
    await store.confirmDocument(1, confirmation());
    fake.tables.set(READINGS, [...fake.rows(READINGS), readingRow(2, 1, 6, { ...TO_CONFIRM, summary: 'Segunda leitura.' })]);
    expect((await store.get(1))?.documentConfirmation).toEqual(confirmation());
  });

  it('#157: a leitura nova com outro documento deixa a confirmação velha no histórico, mas o pedido volta sem confirmação', async () => {
    const { fake, store } = setup();
    await store.confirmDocument(1, confirmation());
    fake.tables.set(READINGS, [...fake.rows(READINGS), readingRow(2, 1, 6, { ...TO_CONFIRM, supplierDocument: '882' })]);
    expect((await store.get(1))?.documentConfirmation).toBeNull();
    expect(await store.confirmDocument(1, confirmation(BETO, '882'))).toBe('recorded');
    expect((await store.get(1))?.documentConfirmation).toEqual(confirmation(BETO, '882'));
  });

  it('#157: uma entrada do histórico fora do formato não vira confirmação', async () => {
    const history = [...(sentRow(1).history as unknown[]), { version: 4, at: 'ontem', by: ANA, action: 'document_confirmed', document: '881', state: { status: 'sent' } }];
    const { store } = setup([sentRow(1, { history })]);
    expect((await store.get(1))?.documentConfirmation).toBeNull();
  });
});
