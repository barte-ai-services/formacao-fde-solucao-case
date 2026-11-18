import { describe, expect, it } from 'vitest';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { LEASE_MS, SupplierStoreError } from '../../src/supplier/supabase-store.js';
import { supabaseSupplierInbox } from '../../src/supplier/supabase-reply-inbox.js';
import { supabaseReplyRequestStore } from '../../src/supplier/supabase-reply-store.js';
import { returnNote } from '../domain/supplier-request-fixtures.js';
import { GOOD_FOLLOW_UP, NOW, noReply, reading } from './reply-doubles.js';
import { INBOX, OUTBOX, READINGS, inboxRow, readingRow, replyHarness, sentRow } from './supabase-reply-support.js';

// #35: o adaptador do pedido na leitura da resposta sobre o PostgREST falso: cada gravação é uma requisição, numa tabela.

const RULE = 'supplier-overdue-sweep'; // #58: quem grava o rascunho montado pela regra na varredura (ADR-005)
const FOLLOW_DUE = '2026-11-25';
const ANA = 'ana@jachegou.example';
const CLAIM = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const FIRST = '11111111-1111-4111-8111-111111111111';
const STAMP = { by: ANA, at: new Date('2026-11-20T16:00:00Z'), channel: 'mock', providerMessageId: 'mock-9' } as const;

const setup = (outbox: Record<string, unknown>[], extra: Record<string, Record<string, unknown>[]> = {}, now: Date = NOW) => {
  const h = replyHarness({ [OUTBOX]: outbox, ...extra });
  return { ...h, store: supabaseReplyRequestStore(h.rest, { now: () => now }) };
};

/** #35: reivindica e devolve a ficha; falha o teste se a reivindicação não for ganha. */
async function won(store: ReturnType<typeof supabaseReplyRequestStore>, id = 1, by = ANA): Promise<string> {
  const attempt = await store.claimFollowUpSend(id, by, GOOD_FOLLOW_UP);
  if (attempt.kind !== 'won') throw new Error('a reivindicação devia ter sido ganha');
  return attempt.claim;
}

const outboxRow = (fake: ReturnType<typeof replyHarness>['fake'], id = 1) => fake.rows(OUTBOX).find((r) => r.id === id) as Record<string, unknown>;
const lastEntry = (row: Record<string, unknown>) => (row.history as Record<string, unknown>[]).at(-1) as Record<string, unknown>;

describe('#35/AC-1 listSent: todo pedido enviado, com a leitura atual, a cobrança, a nota e o fornecedor', () => {
  it('lê só os enviados, na ordem do id, e monta a leitura atual pela ordem das mensagens', async () => {
    const { store } = setup(
      [sentRow(2), sentRow(1), sentRow(3, { status: 'draft', sent_by: null, sent_at: null, channel: null, provider_message_id: null })],
      { [READINGS]: [readingRow(1, 1, 5), readingRow(2, 1, 7), readingRow(3, 2, null)] },
    );
    const list = await store.listSent();
    expect(list.map((r) => r.id)).toEqual([1, 2]);
    expect(list[0]?.reading?.summary).toBe('Leitura da mensagem 7.');
    expect(list[1]?.reading).toEqual(noReply());
    expect(list[0]).toMatchObject({
      invoiceNumber: '43894',
      supplierName: 'Bebidas Rio Claro S.A.',
      requestType: 'return_note',
      to: 'compras@bebidas-rio-claro.example',
      status: 'sent',
      dueOn: '2026-11-17',
      followUp: { draft: null, dueOn: null, rejection: null, sent: null, failure: null },
    });
    expect(list[0]?.note.total).toBe(returnNote().total);
  });

  it('a leitura vem na mesma requisição do pedido, pelo embutido ordenado, e o número da nota na seguinte', async () => {
    const { fake, store } = setup([sentRow(1)]);
    await store.listSent();
    const urls = fake.requests.map((r) => decodeURIComponent(r.url));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('outbox_supplier_emails?');
    expect(urls[0]).toContain('status=eq.sent');
    expect(urls[0]).toContain('supplier_reply_readings!supplier_reply_readings_request_fkey(');
    expect(urls[0]).toContain('supplier_reply_readings.order=message_id.desc.nullslast');
    expect(urls[0]).toContain('kit_fornecedores(razao_social)');
    expect(urls[1]).toContain('invoices?');
    expect(urls[1]).toContain('access_key=in.(');
  });

  it('o estado da cobrança vem das colunas follow_up_*: rascunho, recusa, carimbo e falha', async () => {
    const { store } = setup([
      sentRow(1, { follow_up_draft: GOOD_FOLLOW_UP }),
      sentRow(2, { follow_up_rejection: 'number_mismatch: body' }),
      sentRow(3, {
        follow_up_draft: GOOD_FOLLOW_UP,
        follow_up_claimed_at: '2026-11-20T16:00:00Z',
        follow_up_sent_by: ANA,
        follow_up_sent_at: '2026-11-20T16:00:00Z',
        follow_up_channel: 'mock',
        follow_up_provider_message_id: 'mock-9',
      }),
      sentRow(4, { follow_up_draft: GOOD_FOLLOW_UP, follow_up_failure: 'mailbox_full' }),
    ]);
    const [a, b, c, d] = await store.listSent();
    expect(a?.followUp).toMatchObject({ draft: GOOD_FOLLOW_UP, sent: null });
    expect(b?.followUp).toMatchObject({ draft: null, rejection: 'number_mismatch: body' });
    expect(c?.followUp.sent).toEqual({ by: ANA, at: new Date('2026-11-20T16:00:00Z'), channel: 'mock', providerMessageId: 'mock-9' });
    expect(d?.followUp.failure).toBe('mailbox_full');
  });

  it('sem pedidos enviados, não pergunta pelas notas', async () => {
    const { fake, store } = setup([]);
    expect(await store.listSent()).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });

  it('pedido sem a nota de origem na tabela invoices é dado corrompido: erro nomeado, não lista parcial', async () => {
    const { store } = setup([sentRow(1, { invoice_access_key: '1'.repeat(44) })]);
    await expect(store.listSent()).rejects.toThrow(/nota de origem/);
  });

  it('get lê o pedido de qualquer estado, com a leitura atual; o que não existe é null', async () => {
    const { store } = setup([sentRow(1, { status: 'discarded', discard_reason: 'x', sent_by: null, sent_at: null, channel: null, provider_message_id: null })], { [READINGS]: [readingRow(1, 1, 2)] });
    expect((await store.get(1))?.status).toBe('discarded');
    expect((await store.get(1))?.reading?.summary).toBe('Leitura da mensagem 2.');
    expect(await store.get(9)).toBeNull();
  });
});

describe('#35/AC-1 recordReading: um fato novo por requisição; a mais nova vence pela ordem das mensagens', () => {
  const withMessages = () => setup([sentRow(1)], { [INBOX]: [inboxRow(5, 1), inboxRow(7, 1), inboxRow(8, 1)] });

  it('grava a leitura da mensagem e devolve recorded', async () => {
    const { fake, store } = withMessages();
    expect(await store.recordReading(1, reading({ summary: 'Da 5.' }), 5)).toBe('recorded');
    expect(fake.rows(READINGS)).toHaveLength(1);
    expect(fake.rows(READINGS)[0]).toMatchObject({ request_id: 1, message_id: 5, summary: 'Da 5.' });
  });

  it('a leitura da mensagem 5 depois da 7 é gravada no log e devolve superseded; a atual continua a da 7', async () => {
    const { fake, store } = withMessages();
    await store.recordReading(1, reading({ summary: 'Da 7.' }), 7);
    expect(await store.recordReading(1, reading({ summary: 'Da 5.' }), 5)).toBe('superseded');
    expect(fake.rows(READINGS)).toHaveLength(2);
    expect((await store.get(1))?.reading?.summary).toBe('Da 7.');
  });

  it('a leitura de mensagem mais nova que a guardada troca a atual', async () => {
    const { store } = withMessages();
    await store.recordReading(1, reading({ summary: 'Da 5.' }), 5);
    expect(await store.recordReading(1, reading({ summary: 'Da 8.' }), 8)).toBe('recorded');
    expect((await store.get(1))?.reading?.summary).toBe('Da 8.');
  });

  it('a mesma mensagem lida duas vezes deixa uma linha, a primeira leitura, e devolve recorded', async () => {
    const { fake, store } = withMessages();
    await store.recordReading(1, reading({ summary: 'Primeira.' }), 5);
    expect(await store.recordReading(1, reading({ summary: 'Segunda.' }), 5)).toBe('recorded');
    expect(fake.rows(READINGS)).toHaveLength(1);
    expect((await store.get(1))?.reading?.summary).toBe('Primeira.');
  });

  it('uma gravação é uma requisição POST com on_conflict=message_id e ignore-duplicates, sem ler antes', async () => {
    const { fake, store } = withMessages();
    fake.requests.length = 0;
    await store.recordReading(1, reading(), 5);
    const [post, ...rest] = fake.requests;
    expect(post).toMatchObject({ method: 'POST' });
    expect(post?.url).toContain('on_conflict=message_id');
    expect(post?.headers.Prefer).toContain('resolution=ignore-duplicates');
    expect(rest.every((r) => r.method === 'GET')).toBe(true);
  });

  it('mensagem de outro pedido ou pedido inexistente: o banco recusa (409 23503) e o adaptador lança, não finge superseded', async () => {
    const { fake, store } = withMessages();
    fake.failNext(READINGS, 'POST', 409, { code: '23503', message: 'viola a chave estrangeira' });
    await expect(store.recordReading(1, reading(), 5)).rejects.toBeInstanceOf(SupplierStoreError);
  });
});

describe('#35/AC-3 a varredura do prazo: um único no_reply por pedido, e a resposta tardia vence', () => {
  it('grava o no_reply do pedido sem leitura e devolve recorded; a segunda varredura é superseded (409 23505 no índice parcial)', async () => {
    const { fake, store } = setup([sentRow(1)]);
    expect(await store.recordReading(1, noReply(), null)).toBe('recorded');
    expect(await store.recordReading(1, noReply(), null)).toBe('superseded');
    expect(fake.rows(READINGS)).toHaveLength(1);
    expect(fake.rows(READINGS)[0]).toMatchObject({ message_id: null, reply_outcome: 'no_reply', next_step: 'follow_up' });
  });

  it('a varredura de um pedido que já tem leitura de mensagem é gravada e devolve superseded (não é a atual)', async () => {
    const { store } = setup([sentRow(1)], { [INBOX]: [inboxRow(5, 1)], [READINGS]: [readingRow(1, 1, 5)] });
    expect(await store.recordReading(1, noReply(), null)).toBe('superseded');
    expect((await store.get(1))?.reading?.summary).toBe('Leitura da mensagem 5.');
  });

  it('a resposta tardia vence o no_reply da varredura (#34)', async () => {
    const { store } = setup([sentRow(1)], { [INBOX]: [inboxRow(5, 1)] });
    await store.recordReading(1, noReply(), null);
    expect((await store.get(1))?.reading?.replyOutcome).toBe('no_reply');
    expect(await store.recordReading(1, reading({ summary: 'Tardia.' }), 5)).toBe('recorded');
    expect((await store.get(1))?.reading?.summary).toBe('Tardia.');
  });

  it('outro erro do banco na varredura sobe como SupplierStoreError, não vira superseded', async () => {
    const { fake, store } = setup([sentRow(1)]);
    fake.failNext(READINGS, 'POST', 500, { code: 'XX000', message: 'interno' });
    await expect(store.recordReading(1, noReply(), null)).rejects.toMatchObject({ status: 500, code: 'XX000' });
  });
});

describe('#35/AC-3 #58/AC-1 o rascunho da cobrança: uma gravação guardada, e a cobrança não se repete', () => {
  it('grava o rascunho na linha do pedido, com o novo prazo, a versão +1 e a entrada de histórico no mesmo PATCH', async () => {
    const { fake, store } = setup([sentRow(1)]);
    await store.saveFollowUpDraft(1, GOOD_FOLLOW_UP, FOLLOW_DUE);
    const row = outboxRow(fake);
    expect(row).toMatchObject({ follow_up_draft: { ...GOOD_FOLLOW_UP, dueOn: FOLLOW_DUE }, version: 4 });
    expect(row.history).toHaveLength(3);
    expect(lastEntry(row)).toMatchObject({
      version: 4,
      by: RULE,
      action: 'follow_up_drafted',
      state: { status: 'sent' },
      follow_up: { drafted: true, rejection: null, claimed: false, sent: false, failure: null },
    });
    const patches = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toContain('version=eq.3');
    expect(patches[0]?.url).toContain('status=eq.sent');
  });

  it('o pedido lido traz o novo prazo do rascunho em followUp.dueOn, e o rascunho sem o campo (do Claude, antes da #58) traz nulo', async () => {
    const { store } = setup([sentRow(1, { follow_up_draft: { ...GOOD_FOLLOW_UP, dueOn: FOLLOW_DUE } }), sentRow(2, { follow_up_draft: GOOD_FOLLOW_UP })]);
    const [a, b] = await store.listSent();
    expect(a?.followUp).toMatchObject({ draft: GOOD_FOLLOW_UP, dueOn: FOLLOW_DUE });
    expect(b?.followUp).toMatchObject({ draft: GOOD_FOLLOW_UP, dueOn: null });
  });

  it('com rascunho já gravado, não grava de novo e volta (#35/AC-3)', async () => {
    const { fake, store } = setup([sentRow(1)]);
    await store.saveFollowUpDraft(1, GOOD_FOLLOW_UP, FOLLOW_DUE);
    await store.saveFollowUpDraft(1, { ...GOOD_FOLLOW_UP, subject: 'Outro assunto' }, '2026-12-01');
    expect(outboxRow(fake)).toMatchObject({ follow_up_draft: { ...GOOD_FOLLOW_UP, dueOn: FOLLOW_DUE }, version: 4 });
  });

  it('com uma recusa antiga da tarefa do Claude já gravada, a regra não grava rascunho por cima (a recusa continua sem rascunho)', async () => {
    const { fake, store } = setup([sentRow(1, { follow_up_rejection: 'number_mismatch: body' })]);
    await store.saveFollowUpDraft(1, GOOD_FOLLOW_UP, FOLLOW_DUE);
    expect(outboxRow(fake)).toMatchObject({ follow_up_rejection: 'number_mismatch: body', follow_up_draft: null, version: 3 });
  });

  it('pedido que não existe ou não está enviado: lança com campos nomeados, sem gravar', async () => {
    const { fake, store } = setup([sentRow(2, { status: 'draft', sent_by: null, sent_at: null, channel: null, provider_message_id: null })]);
    await expect(store.saveFollowUpDraft(9, GOOD_FOLLOW_UP, FOLLOW_DUE)).rejects.toBeInstanceOf(SupplierStoreError);
    await expect(store.saveFollowUpDraft(2, GOOD_FOLLOW_UP, FOLLOW_DUE)).rejects.toBeInstanceOf(SupplierStoreError);
    expect(outboxRow(fake, 2).follow_up_draft).toBeNull();
  });
});

describe('#58/AC-4 e #58/AC-5 editFollowUpDraft: troca só o texto do rascunho ainda não enviado e sem envio reivindicado', () => {
  const drafted = () => setup([sentRow(1, { follow_up_draft: { ...GOOD_FOLLOW_UP, dueOn: FOLLOW_DUE } })]);
  const NEW_TEXT = { subject: 'Novo assunto {{nota.numero}}', body: 'Novo corpo {{cobranca.prazo}}.', asks: ['Pedir {{devolucao.total}}'] };

  it('#58/AC-4: grava o texto novo num PATCH guardado, mantém o novo prazo, e o histórico leva quem editou (ADR-005)', async () => {
    const { fake, store } = drafted();
    expect(await store.editFollowUpDraft(1, NEW_TEXT, ANA)).toBe('recorded');
    const row = outboxRow(fake);
    expect(row).toMatchObject({ follow_up_draft: { ...NEW_TEXT, dueOn: FOLLOW_DUE }, version: 4 });
    expect(lastEntry(row)).toMatchObject({ version: 4, by: ANA, action: 'follow_up_edited', follow_up: { drafted: true, sent: false } });
    const patches = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toContain('follow_up_sent_at=is.null');
    expect(patches[0]?.url).toContain('follow_up_claimed_at.is.null'); // #58/AC-5: sem reivindicação, ou com a reivindicação vencida (o `or` da guarda)
    expect(JSON.stringify(lastEntry(row))).not.toContain('Novo corpo');
  });

  it('#58/AC-5: com o carimbo gravado, volta already_sent e não grava', async () => {
    const sent = { follow_up_draft: GOOD_FOLLOW_UP, follow_up_claimed_at: NOW.toISOString(), follow_up_claim: FIRST, follow_up_sent_by: ANA, follow_up_sent_at: NOW.toISOString(), follow_up_channel: 'mock', follow_up_provider_message_id: 'mock-9' };
    const { fake, store } = setup([sentRow(1, sent)]);
    expect(await store.editFollowUpDraft(1, NEW_TEXT, ANA)).toBe('already_sent');
    expect(outboxRow(fake)).toMatchObject({ follow_up_draft: GOOD_FOLLOW_UP, version: 3 });
  });

  it('#58/AC-5: com o envio reivindicado e sem carimbo, volta send_in_progress e não grava', async () => {
    const claimed = { follow_up_draft: GOOD_FOLLOW_UP, follow_up_claimed_at: NOW.toISOString(), follow_up_claim: FIRST };
    const { fake, store } = setup([sentRow(1, claimed)]);
    expect(await store.editFollowUpDraft(1, NEW_TEXT, ANA)).toBe('send_in_progress');
    expect(outboxRow(fake)).toMatchObject({ follow_up_draft: GOOD_FOLLOW_UP, version: 3 });
  });

  it('#58/AC-5: a reivindicação vencida (LEASE_MS) não trava a edição: grava o texto, solta a ficha vencida, e o antigo detentor perde o carimbo', async () => {
    const claimed = { follow_up_draft: { ...GOOD_FOLLOW_UP, dueOn: FOLLOW_DUE }, follow_up_claimed_at: NOW.toISOString(), follow_up_claim: FIRST };
    const later = new Date(NOW.getTime() + LEASE_MS + 1000);
    const { fake, store } = setup([sentRow(1, claimed)], {}, later);
    expect(await store.editFollowUpDraft(1, NEW_TEXT, ANA)).toBe('recorded');
    expect(outboxRow(fake)).toMatchObject({ follow_up_draft: { ...NEW_TEXT, dueOn: FOLLOW_DUE }, follow_up_claimed_at: null, follow_up_claim: null, version: 4 });
    expect(await store.recordFollowUpSent(1, FIRST, STAMP)).toBe('lost'); // #58/AC-5: o envio que parou não carimba o texto antigo como enviado
    expect(await store.claimFollowUpSend(1, ANA, NEW_TEXT)).toEqual({ kind: 'won', claim: CLAIM });
  });

  it('#58/AC-5: a reivindicação ainda dentro do prazo segue travando a edição (send_in_progress, nada gravado)', async () => {
    const claimed = { follow_up_draft: GOOD_FOLLOW_UP, follow_up_claimed_at: NOW.toISOString(), follow_up_claim: FIRST };
    const { fake, store } = setup([sentRow(1, claimed)], {}, new Date(NOW.getTime() + LEASE_MS - 1000));
    expect(await store.editFollowUpDraft(1, NEW_TEXT, ANA)).toBe('send_in_progress');
    expect(outboxRow(fake)).toMatchObject({ follow_up_draft: GOOD_FOLLOW_UP, follow_up_claim: FIRST, version: 3 });
  });

  it('#58/AC-5: a reivindicação vencida de um envio que já saiu não destrava a edição: already_sent', async () => {
    const sent = { follow_up_draft: GOOD_FOLLOW_UP, follow_up_claimed_at: NOW.toISOString(), follow_up_claim: FIRST, follow_up_sent_by: ANA, follow_up_sent_at: NOW.toISOString(), follow_up_channel: 'mock', follow_up_provider_message_id: 'mock-9' };
    const { store } = setup([sentRow(1, sent)], {}, new Date(NOW.getTime() + 10 * LEASE_MS));
    expect(await store.editFollowUpDraft(1, NEW_TEXT, ANA)).toBe('already_sent');
  });

  it('#58/AC-4: sem rascunho a gravação é recusada (lança, sem gravar), e o pedido que não existe também', async () => {
    const { fake, store } = setup([sentRow(1)]);
    await expect(store.editFollowUpDraft(1, NEW_TEXT, ANA)).rejects.toBeInstanceOf(SupplierStoreError);
    await expect(store.editFollowUpDraft(9, NEW_TEXT, ANA)).rejects.toBeInstanceOf(SupplierStoreError);
    expect(outboxRow(fake).follow_up_draft).toBeNull();
  });
});

describe('#35/AC-4 a reivindicação do envio: uma transição guardada e atômica', () => {
  const drafted = () => setup([sentRow(1, { follow_up_draft: GOOD_FOLLOW_UP })]);

  it('#58/AC-5: o texto que o envio leu já não é o gravado: volta stale e não reivindica nem grava nada', async () => {
    const { fake, store } = setup([sentRow(1, { follow_up_draft: { ...GOOD_FOLLOW_UP, body: 'Texto editado depois da leitura.' } })]);
    expect(await store.claimFollowUpSend(1, ANA, GOOD_FOLLOW_UP)).toEqual({ kind: 'stale' });
    expect(outboxRow(fake)).toMatchObject({ follow_up_claimed_at: null, follow_up_claim: null, version: 3 });
    expect(fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });

  it('#58/AC-5: a edição que entra entre a leitura da linha e a gravação da reivindicação é pega pela versão: volta stale e o texto editado fica', async () => {
    const h = replyHarness({ [OUTBOX]: [sentRow(1, { follow_up_draft: GOOD_FOLLOW_UP })] });
    let edited = false;
    const racing = new SupabaseRest({
      url: 'https://projeto.test',
      secretKey: 'sb_secret_teste',
      fetch: (input, init) => {
        if (!edited && init?.method === 'PATCH') {
          edited = true; // #58/AC-5: a edição de outra pessoa entra aqui: depois da leitura do envio e antes do seu PATCH
          Object.assign(outboxRow(h.fake), { follow_up_draft: { ...GOOD_FOLLOW_UP, body: 'Texto editado no meio.' }, version: 4 });
        }
        return h.fake.fetch(input, init);
      },
    });
    const store = supabaseReplyRequestStore(racing, { now: () => NOW });
    expect(await store.claimFollowUpSend(1, ANA, GOOD_FOLLOW_UP)).toEqual({ kind: 'stale' });
    expect(outboxRow(h.fake)).toMatchObject({ follow_up_draft: { body: 'Texto editado no meio.' }, follow_up_claimed_at: null, follow_up_claim: null, version: 4 });
  });

  it('duas reivindicações ao mesmo tempo, na mesma versão: uma ganha, com a ficha, e a outra volta taken', async () => {
    const { fake, store } = drafted();
    const results = await Promise.all([store.claimFollowUpSend(1, ANA, GOOD_FOLLOW_UP), store.claimFollowUpSend(1, 'beto@jachegou.example', GOOD_FOLLOW_UP)]);
    expect(results.filter((r) => r.kind === 'taken')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'won')).toEqual([{ kind: 'won', claim: CLAIM }]);
    expect(outboxRow(fake)).toMatchObject({ follow_up_claimed_at: NOW.toISOString(), version: 4 });
    expect(outboxRow(fake).follow_up_claim).toEqual(CLAIM);
    expect(lastEntry(outboxRow(fake))).toMatchObject({ action: 'follow_up_claimed', follow_up: { claimed: true } });
  });

  it('#35 a ficha da reivindicação vai para a coluna e nunca para o histórico nem para a leitura do pedido', async () => {
    const { fake, store } = drafted();
    const claim = await won(store);
    expect(outboxRow(fake).follow_up_claim).toBe(claim);
    expect(JSON.stringify(outboxRow(fake).history)).not.toContain(claim);
    expect(JSON.stringify(await store.get(1))).not.toContain(claim);
  });

  it('#35 a reivindicação tem prazo (o da #12): dentro dele volta taken; vencida, é retomada com outra ficha', async () => {
    const claimed = { follow_up_draft: GOOD_FOLLOW_UP, follow_up_claimed_at: NOW.toISOString(), follow_up_claim: FIRST };
    const inside = setup([sentRow(1, claimed)], {}, new Date(NOW.getTime() + LEASE_MS - 1000));
    expect(await inside.store.claimFollowUpSend(1, ANA, GOOD_FOLLOW_UP)).toEqual({ kind: 'taken' });
    expect(outboxRow(inside.fake)).toMatchObject({ follow_up_claimed_at: NOW.toISOString(), follow_up_claim: FIRST, version: 3 });
    const later = new Date(NOW.getTime() + LEASE_MS + 1000);
    const expired = setup([sentRow(1, claimed)], {}, later);
    expect(await expired.store.claimFollowUpSend(1, ANA, GOOD_FOLLOW_UP)).toEqual({ kind: 'won', claim: CLAIM });
    expect(outboxRow(expired.fake)).toMatchObject({ follow_up_claimed_at: later.toISOString(), version: 4 });
    expect(outboxRow(expired.fake).follow_up_claim).not.toBe(FIRST);
  });

  it('#35 a reivindicação vencida de um envio que já saiu não é retomada: o carimbo impede o segundo e-mail', async () => {
    const sent = { follow_up_draft: GOOD_FOLLOW_UP, follow_up_claimed_at: NOW.toISOString(), follow_up_claim: FIRST, follow_up_sent_by: ANA, follow_up_sent_at: NOW.toISOString(), follow_up_channel: 'mock', follow_up_provider_message_id: 'mock-9' };
    const { store } = setup([sentRow(1, sent)], {}, new Date(NOW.getTime() + 10 * LEASE_MS));
    expect(await store.claimFollowUpSend(1, ANA, GOOD_FOLLOW_UP)).toEqual({ kind: 'taken' });
  });

  it('o histórico leva quem reivindicou', async () => {
    const { fake, store } = drafted();
    await store.claimFollowUpSend(1, ANA, GOOD_FOLLOW_UP);
    expect(lastEntry(outboxRow(fake)).by).toBe(ANA);
  });

  it('sem rascunho, ou de pedido que não está enviado, volta taken sem gravar', async () => {
    const { fake, store } = setup([sentRow(1), sentRow(2, { follow_up_draft: GOOD_FOLLOW_UP, status: 'discarded', discard_reason: 'x', sent_by: null, sent_at: null, channel: null, provider_message_id: null })]);
    expect(await store.claimFollowUpSend(1, ANA, GOOD_FOLLOW_UP)).toEqual({ kind: 'taken' });
    expect(await store.claimFollowUpSend(2, ANA, GOOD_FOLLOW_UP)).toEqual({ kind: 'taken' });
    expect(await store.claimFollowUpSend(99, ANA, GOOD_FOLLOW_UP)).toEqual({ kind: 'taken' });
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(2);
  });

  it('a falha de quem detém a reivindicação a solta, com a ficha, e guarda o motivo curto: nova reivindicação ganha', async () => {
    const { fake, store } = drafted();
    const claim = await won(store);
    expect(await store.recordFollowUpFailure(1, claim, 'mailbox_full', ANA)).toBe('recorded');
    expect(outboxRow(fake)).toMatchObject({ follow_up_claimed_at: null, follow_up_claim: null, follow_up_failure: 'mailbox_full' });
    expect(lastEntry(outboxRow(fake))).toMatchObject({ action: 'follow_up_failed', by: ANA, follow_up: { claimed: false, failure: 'mailbox_full' } });
    expect(await store.claimFollowUpSend(1, ANA, GOOD_FOLLOW_UP)).toEqual({ kind: 'won', claim: CLAIM });
  });

  it('o envio de quem detém a reivindicação guarda o carimbo, limpa a falha e mantém a reivindicação', async () => {
    const { fake, store } = drafted();
    await store.recordFollowUpFailure(1, await won(store), 'mailbox_full', ANA);
    const claim = await won(store);
    expect(await store.recordFollowUpSent(1, claim, STAMP)).toBe('recorded');
    expect(outboxRow(fake)).toMatchObject({
      follow_up_sent_by: ANA,
      follow_up_sent_at: STAMP.at.toISOString(),
      follow_up_channel: 'mock',
      follow_up_provider_message_id: 'mock-9',
      follow_up_failure: null,
      follow_up_claimed_at: NOW.toISOString(),
      follow_up_claim: claim,
    });
    expect(lastEntry(outboxRow(fake))).toMatchObject({ action: 'follow_up_sent', by: ANA, at: STAMP.at.toISOString(), follow_up: { sent: true, claimed: true } });
    expect(await store.claimFollowUpSend(1, ANA, GOOD_FOLLOW_UP)).toEqual({ kind: 'taken' });
    expect((await store.get(1))?.followUp.sent).toEqual(STAMP);
  });

  it('falha ou envio sem reivindicação de pé, ou com a ficha de outra, voltam lost: nada é gravado', async () => {
    const { fake, store } = drafted();
    expect(await store.recordFollowUpFailure(1, FIRST, 'mailbox_full', ANA)).toBe('lost');
    expect(await store.recordFollowUpSent(1, FIRST, STAMP)).toBe('lost');
    expect(outboxRow(fake).version).toBe(3);
    await won(store);
    const version = outboxRow(fake).version;
    expect(await store.recordFollowUpFailure(1, FIRST, 'mailbox_full', ANA)).toBe('lost');
    expect(await store.recordFollowUpSent(1, FIRST, STAMP)).toBe('lost');
    expect(outboxRow(fake)).toMatchObject({ version, follow_up_failure: null, follow_up_sent_at: null });
    expect(outboxRow(fake).follow_up_claim).toEqual(CLAIM);
  });

  it('pedido inexistente: falha e envio lançam, como as outras gravações', async () => {
    const { store } = drafted();
    await expect(store.recordFollowUpFailure(99, FIRST, 'mailbox_full', ANA)).rejects.toBeInstanceOf(SupplierStoreError);
    await expect(store.recordFollowUpSent(99, FIRST, STAMP)).rejects.toBeInstanceOf(SupplierStoreError);
  });

  it('claim, a reivindicação vence, segunda reivindicação: a falha e o carimbo do primeiro detentor são recusados (#35 REL-3)', async () => {
    const first = setup([sentRow(1, { follow_up_draft: GOOD_FOLLOW_UP })]);
    const claimA = await won(first.store);
    const later = new Date(NOW.getTime() + LEASE_MS + 1000);
    const second = supabaseReplyRequestStore(first.rest, { now: () => later });
    const claimB = await won(second);
    expect(claimB).not.toBe(claimA);

    // #35 REL-3: A estagnou e volta: a falha dele não solta a reivindicação de B, e o carimbo dele não vale.
    expect(await first.store.recordFollowUpFailure(1, claimA, 'mailbox_full', ANA)).toBe('lost');
    expect(outboxRow(first.fake)).toMatchObject({ follow_up_claim: claimB, follow_up_claimed_at: later.toISOString(), follow_up_failure: null });
    expect(await second.claimFollowUpSend(1, 'beto@jachegou.example', GOOD_FOLLOW_UP)).toEqual({ kind: 'taken' }); // #35: ninguém mais reivindica
    expect(await first.store.recordFollowUpSent(1, claimA, STAMP)).toBe('lost');
    expect(outboxRow(first.fake)).toMatchObject({ follow_up_sent_at: null, follow_up_claim: claimB });

    // #35 REL-3: B, o detentor, grava o carimbo.
    expect(await second.recordFollowUpSent(1, claimB, { ...STAMP, by: 'beto@jachegou.example' })).toBe('recorded');
    expect(outboxRow(first.fake)).toMatchObject({ follow_up_sent_by: 'beto@jachegou.example', follow_up_claim: claimB });
  });

  it('o motivo da falha fora do formato curto é recusado sem gravar (o texto do provedor não cabe)', async () => {
    const { fake, store } = drafted();
    const claim = await won(store);
    await expect(store.recordFollowUpFailure(1, claim, 'smtp 550 caixa cheia token=sk-segredo', ANA)).rejects.toBeInstanceOf(SupplierStoreError);
    expect(outboxRow(fake).follow_up_failure).toBeNull();
  });
});

describe('#4/AC-6 e #35/AC-2 nada alcança a proposta, o título nem o valor em risco', () => {
  it('toda requisição dos adaptadores toca só as três tabelas da leitura; o que lê a mais é só invoices e kit_fornecedores', async () => {
    const { fake, store, rest } = setup([sentRow(1), sentRow(2)], { [INBOX]: [inboxRow(5, 1)] });
    const inbox = supabaseSupplierInbox(rest, { now: () => NOW });
    await store.listSent();
    await store.get(1);
    await store.recordReading(1, reading(), 5);
    await store.recordReading(2, noReply(), null);
    await store.saveFollowUpDraft(1, GOOD_FOLLOW_UP, FOLLOW_DUE);
    await store.editFollowUpDraft(1, GOOD_FOLLOW_UP, ANA);
    await store.saveFollowUpDraft(2, GOOD_FOLLOW_UP, FOLLOW_DUE);
    await store.recordFollowUpFailure(1, await won(store), 'mailbox_full', ANA);
    await store.recordFollowUpSent(1, await won(store), STAMP);
    await inbox.listPending();
    await inbox.markRead(5);

    const tableOf = (url: string): string => new URL(url).pathname.replace('/rest/v1/', '');
    const writes = fake.requests.filter((r) => r.method !== 'GET');
    expect(new Set(writes.map((r) => tableOf(r.url)))).toEqual(new Set([OUTBOX, READINGS, INBOX]));
    expect(new Set(fake.requests.map((r) => tableOf(r.url)))).toEqual(new Set([OUTBOX, READINGS, INBOX, 'invoices']));
    expect(writes.some((r) => r.method === 'DELETE')).toBe(false);
    expect(fake.rows('proposals')).toEqual([]);
    expect(fake.rows('titles')).toEqual([]);
  });

  it('um PATCH no pedido leva só colunas follow_up_*, version, history e updated_at', async () => {
    const { fake, store } = setup([sentRow(1)]);
    await store.saveFollowUpDraft(1, GOOD_FOLLOW_UP, FOLLOW_DUE);
    await store.recordFollowUpFailure(1, await won(store), 'mailbox_full', ANA);
    await store.recordFollowUpSent(1, await won(store), STAMP);
    const patches = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(5);
    for (const patch of patches) {
      for (const column of Object.keys(patch.body as object)) {
        expect(column).toMatch(/^(follow_up_\w+|version|history|updated_at)$/);
      }
    }
  });

  it('a leitura gravada não tem coluna de proposta, título nem valor em risco', async () => {
    const { fake, store } = setup([sentRow(1)], { [INBOX]: [inboxRow(5, 1)] });
    await store.recordReading(1, reading(), 5);
    expect(Object.keys(fake.rows(READINGS)[0] ?? {}).join(',')).not.toMatch(/proposal|title|amount|risk|decision/);
  });
});

describe('#35 a falha do banco sai só com campos nomeados', () => {
  it('o erro do PostgREST em um PATCH vira SupplierStoreError sem o texto da resposta', async () => {
    const { fake, store } = setup([sentRow(1, { follow_up_draft: GOOD_FOLLOW_UP })]);
    fake.failNext(OUTBOX, 'PATCH', 500, { code: '40001', message: 'postgres://u:senha@db.interno', hint: 'role service_role' });
    const error = await store.claimFollowUpSend(1, ANA, GOOD_FOLLOW_UP).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: 'SupplierStoreError', operation: 'update', table: OUTBOX, status: 500, code: '40001' });
    expect(JSON.stringify(error) + String((error as Error).message) + String((error as Error).cause ?? '')).not.toMatch(/senha|postgres:|service_role/);
  });
});
