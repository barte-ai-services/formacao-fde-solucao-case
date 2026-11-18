import { describe, expect, it } from 'vitest';
import type { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { buildSupplierRequestFacts, type SupplierRequest } from '../../src/domain/index.js';
import { supabaseIssuedNoteStore } from '../../src/supplier/supabase-notes.js';
import { LEASE_MS, supabaseSupplierRequestStore } from '../../src/supplier/supabase-store.js';
import type { RequestRecord, SendStamp, SupplierRequestStore } from '../../src/supplier/ports.js';
import { returnNote, sourceInvoice } from '../domain/supplier-request-fixtures.js';
import { NOW } from './doubles.js';
import { harness, newRequest } from './supabase-support.js';

// #156: o adaptador do pedido ao fornecedor sobre o PostgREST falso (sem banco real: cada requisição é uma transação).

const TABLE = 'outbox_supplier_emails';
const BY = 'ana@jachegou.example';
const OTHER = 'outra@jachegou.example';
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
const catalog = buildSupplierRequestFacts(returnNote(), sourceInvoice(), '2026-11-17');

const created = async (store: SupplierRequestStore, over = {}): Promise<RequestRecord> => {
  const result = await store.create(newRequest(over));
  if (result.kind !== 'ok') throw new Error('o pedido deveria ter sido criado');
  return result.record;
};

/** #156: a trava tomada; a chave que o envio leva em cada gravação sua. */
const claimOf = async (store: SupplierRequestStore, id: number, when: Date): Promise<string> => {
  const result = await store.claimSend(id, BY, when);
  if (result.kind !== 'claimed') throw new Error('a trava deveria ter sido tomada');
  return result.claim;
};

const stamp: SendStamp = {
  channel: 'mock',
  providerMessageId: 'mock-1',
  attachments: [{ filename: 'ND-1.json', contentType: 'application/json', issuedReturnNoteId: 1 }],
};

/** #156: o envio inteiro pelas portas: trava, emissão registrada e o carimbo de enviado. */
const sendFlow = async (rest: SupabaseRest, store: SupplierRequestStore, request: SupplierRequest): Promise<void> => {
  const notes = supabaseIssuedNoteStore(rest);
  const claim = await claimOf(store, request.id, NOW);
  request.recordIssuance(await notes.issue(7, request.note, '2026-11-12'));
  await store.save(request, { by: BY, at: NOW, action: 'issued', claim });
  request.markSent();
  await store.save(request, { by: BY, at: NOW, action: 'sent', sent: stamp, claim });
};

describe('#156 um pedido aberto por nota de origem e tipo', () => { // ADR-002
  it('cria o rascunho com a versão 1 e a primeira entrada do histórico, e devolve a raiz com o id da tabela', async () => { // ADR-002
    const { fake, rest } = harness();
    const record = await created(supabaseSupplierRequestStore(rest));
    expect(record.request.id).toBe(1);
    expect(record.request.status).toBe('draft');
    expect(record.queueId).toBe(7);
    const [row] = fake.rows(TABLE);
    expect(row).toMatchObject({ version: 1, request_type: 'return_note', status: 'draft', supplier_id: 'F02', queue_id: 7 });
    expect(row?.history).toEqual([
      expect.objectContaining({ version: 1, by: 'agente', action: 'drafted', state: expect.objectContaining({ status: 'draft' }) }),
    ]);
  });

  it('um segundo pedido aberto da mesma nota e tipo é conflito (o índice parcial responde 409 com 23505)', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    await created(store);
    expect(await store.create(newRequest())).toEqual({ kind: 'conflict' });
    expect(fake.rows(TABLE)).toHaveLength(1);
  });

  it('com o pedido anterior descartado, outro entra', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const first = await created(store);
    first.request.discard('texto ruim');
    await store.save(first.request, { by: BY, at: NOW, action: 'discarded' });
    expect((await store.create(newRequest())).kind).toBe('ok');
    expect(fake.rows(TABLE)).toHaveLength(2);
  });

  it('findOpen acha o aberto e ignora o descartado; get lê por id; o que não existe é null', async () => { // ADR-002
    const { rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const record = await created(store);
    expect((await store.findOpen(record.request.invoiceAccessKey, 'return_note'))?.request.id).toBe(1);
    expect((await store.get(1))?.to).toBe(record.to);
    expect(await store.get(99)).toBeNull();
    record.request.discard('x');
    await store.save(record.request, { by: BY, at: NOW, action: 'discarded' });
    expect(await store.findOpen(record.request.invoiceAccessKey, 'return_note')).toBeNull();
  });

  it('o filtro do findOpen repete o predicado do índice parcial', async () => { // ADR-002
    const { fake, rest } = harness();
    await supabaseSupplierRequestStore(rest).findOpen('chave', 'return_note');
    expect(decodeURIComponent(fake.requests.at(-1)?.url ?? '')).toContain('status=in.(draft,sent,send_failed)');
  });

  it('outro 409 (uma chave estrangeira, 23503) sobe como erro, sem o texto nem o corpo da resposta do banco', async () => { // ADR-002
    const { fake, rest } = harness();
    fake.failNext(TABLE, 'POST', 409, { code: '23503', message: 'Key (queue_id)=(7) segredo-do-banco is not present', details: 'dado-do-fornecedor' });
    const error: unknown = await supabaseSupplierRequestStore(rest).create(newRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const text = String((error as Error).message) + JSON.stringify(error);
    expect(text).toContain('23503');
    expect(text).not.toContain('segredo-do-banco');
    expect(text).not.toContain('dado-do-fornecedor');
  });

  it('um erro que não é de conflito também sobe sem o corpo (HTTP 500)', async () => { // ADR-002
    const { fake, rest } = harness();
    fake.failNext(TABLE, 'POST', 500, { message: 'senha-do-banco no log' });
    const error: unknown = await supabaseSupplierRequestStore(rest).create(newRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain('senha-do-banco');
  });
});

describe('#156 o pedido guarda o que o caso de uso precisa', () => { // ADR-002
  it('guarda destinatário, assunto, corpo com marcadores, o que pedimos, a nota, o prazo, o modelo e o dia do rascunho', async () => { // ADR-002
    const { fake, rest } = harness();
    await created(supabaseSupplierRequestStore(rest));
    expect(fake.rows(TABLE)[0]).toMatchObject({
      recipient: 'compras@bebidas-rio-claro.example',
      subject: 'Devolução da nota {{nota.numero}}',
      attachments: [],
      drafted_on: '2026-11-12',
      due_on: '2026-11-17',
      model: 'claude-teste',
      send_claim: null,
      sent_by: null,
    });
    expect(fake.rows(TABLE)[0]?.asks).toHaveLength(2);
    expect(String(fake.rows(TABLE)[0]?.body)).toContain('{{devolucao.total}}');
  });

  it('o texto recusado nasce descartado com o motivo, sem texto, e o histórico diz rejected', async () => { // ADR-002
    const { fake, rest } = harness();
    const record = await created(supabaseSupplierRequestStore(rest), {
      outcome: { kind: 'rejected', rejection: { ok: false, reason: 'number_mismatch', field: 'body' } },
    });
    expect(record.request.status).toBe('discarded');
    expect(record.request.discardReason).toBe('number_mismatch: body');
    expect(fake.rows(TABLE)[0]).toMatchObject({ subject: '', body: '', asks: [], status: 'discarded', discard_reason: 'number_mismatch: body' });
    expect((fake.rows(TABLE)[0]?.history as { action: string }[])[0]?.action).toBe('rejected');
    expect((await supabaseSupplierRequestStore(rest).get(1))?.request.discardReason).toBe('number_mismatch: body');
  });

  it('editar o corpo é um PATCH filtrado pela versão lida: versão +1 e uma entrada de histórico com quem, quando e o estado', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    request.editBody('Pedimos o retorno até {{prazo}}.', catalog);
    expect(await store.save(request, { by: BY, at: NOW, action: 'edited' })).toBe('ok');
    const row = fake.rows(TABLE)[0];
    expect(row).toMatchObject({ version: 2, body: 'Pedimos o retorno até {{prazo}}.' });
    expect(row?.history).toEqual([
      expect.objectContaining({ version: 1, action: 'drafted' }),
      { version: 2, at: NOW.toISOString(), by: BY, action: 'edited', state: expect.objectContaining({ status: 'draft', body: 'Pedimos o retorno até {{prazo}}.' }) },
    ]);
    const patch = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patch).toHaveLength(1);
    expect(decodeURIComponent(patch[0]?.url ?? '')).toContain('version=eq.1');
  });

  it('duas edições seguidas geram versões seguidas', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    request.editBody('Um {{prazo}}.', catalog);
    await store.save(request, { by: BY, at: NOW, action: 'edited' });
    request.editBody('Dois {{prazo}}.', catalog);
    await store.save(request, { by: BY, at: at(1), action: 'edited' });
    expect((fake.rows(TABLE)[0]?.history as { version: number }[]).map((h) => h.version)).toEqual([1, 2, 3]);
    expect(fake.rows(TABLE)[0]?.version).toBe(3);
  });

  it('gravar com a versão velha volta stale e não muda a linha', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const record = await created(store);
    const other = supabaseSupplierRequestStore(rest);
    const second = await other.get(record.request.id);
    second?.request.discard('outro');
    expect(await other.save(second!.request, { by: OTHER, at: NOW, action: 'discarded' })).toBe('ok');
    record.request.discard('eu');
    expect(await store.save(record.request, { by: BY, at: NOW, action: 'discarded' })).toBe('stale');
    expect(fake.rows(TABLE)[0]).toMatchObject({ discard_reason: 'outro', discarded_by: OTHER, version: 2 });
  });

  it('descartar grava o motivo, quem e quando, e a raiz lida de volta está descartada com o motivo', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    request.discard('fornecedor avisado por telefone');
    await store.save(request, { by: BY, at: NOW, action: 'discarded' });
    expect(fake.rows(TABLE)[0]).toMatchObject({
      status: 'discarded',
      discard_reason: 'fornecedor avisado por telefone',
      discarded_by: BY,
      discarded_at: NOW.toISOString(),
      version: 2,
    });
    const back = await store.get(request.id);
    expect(back?.request.status).toBe('discarded');
    expect(back?.request.discardReason).toBe('fornecedor avisado por telefone');
  });

  it('o envio grava quem, quando, o canal, o id do provedor e os anexos, e a raiz lida de volta é a mesma, com a nota emitida', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    await sendFlow(rest, store, request);
    expect(fake.rows(TABLE)[0]).toMatchObject({
      status: 'sent',
      sent_by: BY,
      sent_at: NOW.toISOString(),
      channel: 'mock',
      provider_message_id: 'mock-1',
      issued_return_note_id: 1,
      attachments: [{ filename: 'ND-1.json', content_type: 'application/json', issued_return_note_id: 1 }],
      send_claim: null,
      send_claimed_at: null,
    });
    const back = (await store.get(request.id))?.request;
    expect(back?.status).toBe('sent');
    expect(back?.issuedNote?.noteId).toBe('ND-1');
    expect(back?.issuedNote?.accessKey).toBe(request.issuedNote?.accessKey);
    expect(back?.note).toEqual(returnNote());
  });

  it('o histórico do envio inteiro: rascunho, trava, emissão, enviado, com versões seguidas', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    await sendFlow(rest, store, request);
    const history = fake.rows(TABLE)[0]?.history as { version: number; action: string }[];
    expect(history.map((h) => [h.version, h.action])).toEqual([
      [1, 'drafted'],
      [2, 'send_claimed'],
      [3, 'issued'],
      [4, 'sent'],
    ]);
  });

  it('a falha do envio grava o motivo e limpa a trava; lido de volta é send_failed com o motivo; reenviar depois fica enviado', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    const notes = supabaseIssuedNoteStore(rest);
    const first = await claimOf(store, request.id, NOW);
    request.recordIssuance(await notes.issue(7, request.note, '2026-11-12'));
    await store.save(request, { by: BY, at: NOW, action: 'issued', claim: first });
    request.markSendFailed('caixa_de_saida_indisponivel');
    await store.save(request, { by: BY, at: NOW, action: 'send_failed', claim: first });
    expect(fake.rows(TABLE)[0]).toMatchObject({ status: 'send_failed', send_failure_reason: 'caixa_de_saida_indisponivel', send_claim: null });
    const again = await store.get(request.id);
    expect(again?.request.status).toBe('send_failed');
    expect(again?.request.sendFailureReason).toBe('caixa_de_saida_indisponivel');

    const second = await claimOf(store, request.id, at(1));
    again!.request.markSent();
    expect(await store.save(again!.request, { by: BY, at: at(1), action: 'sent', sent: stamp, claim: second })).toBe('ok');
    const sent = await store.get(request.id);
    expect(sent?.request.status).toBe('sent');
    expect(sent?.request.sendFailureReason).toBe('caixa_de_saida_indisponivel');
  });

  it('linha com o prazo diferente do que a regra calcula é dado corrompido: falha em vez de montar o pedido', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    await created(store);
    fake.rows(TABLE)[0]!.due_on = '2030-01-01';
    await expect(store.get(1)).rejects.toThrow();
  });

  it('nunca apaga: nenhum DELETE, e todo PATCH carrega o filtro da versão', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    await sendFlow(rest, store, request);
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false);
    const patches = fake.requests.filter((x) => x.method === 'PATCH' && x.url.includes(TABLE));
    expect(patches.length).toBeGreaterThan(0);
    for (const r of patches) expect(decodeURIComponent(r.url)).toMatch(/version=eq\.\d+/);
  });
});

describe('#156 a trava do envio concorrente', () => { // ADR-002
  it('dois envios na mesma versão: um ganha a trava, o outro é conflito', async () => { // ADR-002
    const { fake, rest } = harness();
    const a = supabaseSupplierRequestStore(rest);
    const b = supabaseSupplierRequestStore(rest);
    const { request } = await created(a);
    await b.get(request.id);
    const first = await a.claimSend(request.id, BY, NOW);
    const second = await b.claimSend(request.id, OTHER, NOW);
    expect(first.kind).toBe('claimed');
    expect(second).toEqual({ kind: 'conflict' });
    expect(fake.rows(TABLE)[0]).toMatchObject({ send_claim: first.kind === 'claimed' ? first.claim : '', send_claimed_at: NOW.toISOString(), version: 2 });
  });

  it('com a trava ativa, quem lê depois também é recusado, mesmo lendo a versão nova', async () => { // ADR-002
    const { rest } = harness();
    const a = supabaseSupplierRequestStore(rest);
    const b = supabaseSupplierRequestStore(rest);
    const { request } = await created(a);
    await a.claimSend(request.id, BY, NOW);
    await b.get(request.id);
    expect(await b.claimSend(request.id, OTHER, at(1))).toEqual({ kind: 'conflict' });
  });

  it('a trava vencida (passou o prazo) é retomada', async () => { // ADR-002
    const { rest } = harness();
    const a = supabaseSupplierRequestStore(rest);
    const b = supabaseSupplierRequestStore(rest);
    const { request } = await created(a);
    await a.claimSend(request.id, BY, NOW);
    await b.get(request.id);
    const later = new Date(NOW.getTime() + LEASE_MS + 1000);
    expect((await b.claimSend(request.id, OTHER, later)).kind).toBe('claimed');
  });

  it('o prazo da trava é de 5 minutos', () => { // ADR-002
    expect(LEASE_MS).toBe(5 * 60_000);
  });

  it('com a trava ativa, editar e descartar sem a chave são recusados (stale); quem leva a chave grava', async () => { // ADR-002
    const { fake, rest } = harness();
    const holder = supabaseSupplierRequestStore(rest);
    const person = supabaseSupplierRequestStore(rest);
    const { request } = await created(holder);
    const claim = await claimOf(holder, request.id, NOW);
    const seen = await person.get(request.id);
    seen?.request.discard('quero descartar');
    expect(await person.save(seen!.request, { by: OTHER, at: at(1), action: 'discarded' })).toBe('stale');
    expect(fake.rows(TABLE)[0]?.status).toBe('draft');
    request.discard('o dono da trava grava');
    expect(await holder.save(request, { by: BY, at: at(1), action: 'discarded', claim })).toBe('ok');
  });

  it('na MESMA instância do adaptador, a edição durante o envio em curso é stale e o envio ainda grava enviado', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    const claim = await claimOf(store, request.id, NOW);
    const reread = await store.get(request.id); // #156: a trava não vem da leitura
    reread?.request.editBody('Pedimos o retorno até {{prazo}}.', catalog);
    expect(await store.save(reread!.request, { by: OTHER, at: at(1), action: 'edited' })).toBe('stale');
    expect(fake.rows(TABLE)[0]).toMatchObject({ send_claim: claim, version: 2 });
    request.markSent();
    expect(await store.save(request, { by: BY, at: at(1), action: 'sent', sent: stamp, claim })).toBe('ok');
    expect(fake.rows(TABLE)[0]).toMatchObject({ status: 'sent', send_claim: null });
  });

  it('a gravação com a chave errada é stale, e a gravação com a chave só filtra por ela quando ela é dada', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    const claim = await claimOf(store, request.id, NOW);
    request.discard('x');
    expect(await store.save(request, { by: BY, at: at(1), action: 'discarded', claim: 'outra-chave' })).toBe('stale');
    expect(await store.save(request, { by: BY, at: at(1), action: 'discarded', claim })).toBe('ok');
    const patches = fake.requests.filter((r) => r.method === 'PATCH').map((r) => decodeURIComponent(r.url));
    expect(patches.at(-1)).toContain(`send_claim=eq.${claim}`);
    expect(patches.at(-1)).not.toContain('or=(');
  });

  it('a gravação sem chave só passa com a trava livre ou vencida', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    request.discard('x');
    await store.save(request, { by: BY, at: NOW, action: 'discarded' });
    const patch = decodeURIComponent(fake.requests.filter((r) => r.method === 'PATCH').at(-1)?.url ?? '');
    expect(patch).toContain('or=(send_claim.is.null,send_claimed_at.lt.');
    expect(patch).not.toContain('send_claim=eq.');
  });

  it('só se trava rascunho ou send_failed: o descartado volta conflito', async () => { // ADR-002
    const { rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const record = await created(store);
    record.request.discard('x');
    await store.save(record.request, { by: BY, at: NOW, action: 'discarded' });
    await store.get(record.request.id);
    expect(await store.claimSend(record.request.id, BY, at(1))).toEqual({ kind: 'conflict' });
  });

  it('soltar a trava a limpa, sobe a versão e registra no histórico; depois o pedido se descarta', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    const claim = await claimOf(store, request.id, NOW);
    await store.releaseSend(request.id, claim, BY, at(1));
    expect(fake.rows(TABLE)[0]).toMatchObject({ send_claim: null, send_claimed_at: null, version: 3 });
    expect((fake.rows(TABLE)[0]?.history as { action: string }[]).map((h) => h.action)).toEqual(['drafted', 'send_claimed', 'send_released']);
    request.discard('depois da trava solta');
    expect(await store.save(request, { by: BY, at: at(2), action: 'discarded' })).toBe('ok');
  });

  it('soltar com a chave de outro envio não solta nada', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    const claim = await claimOf(store, request.id, NOW);
    await store.releaseSend(request.id, 'chave-de-outro-envio', BY, at(1));
    expect(fake.rows(TABLE)[0]).toMatchObject({ send_claim: claim, version: 2 });
  });

  it('a trava é pedida por um PATCH condicional a versão, ao estado e ao prazo', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    await store.claimSend(request.id, BY, NOW);
    const patch = decodeURIComponent(fake.requests.filter((r) => r.method === 'PATCH').at(-1)?.url ?? '');
    expect(patch).toContain('version=eq.1');
    expect(patch).toContain('status=in.(draft,send_failed)');
    expect(patch).toContain(`or=(send_claim.is.null,send_claimed_at.lt.${new Date(NOW.getTime() - LEASE_MS).toISOString()})`);
  });
});

describe('#156 os pedidos abertos de um tipo, só das notas pedidas, numa leitura', () => { // ADR-002
  it('listOpenKeys devolve só as chaves perguntadas com pedido aberto, sem o descartado, numa única requisição', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const first = await created(store);
    await created(store, { invoiceAccessKey: 'outra-chave', queueId: 8 });
    await created(store, { invoiceAccessKey: 'fora-da-pergunta', queueId: 9 });
    first.request.discard('x');
    await store.save(first.request, { by: BY, at: NOW, action: 'discarded' });
    const before = fake.requests.length;
    const keys = await store.listOpenKeys('return_note', [first.request.invoiceAccessKey, 'outra-chave']);
    expect([...keys]).toEqual(['outra-chave']);
    expect(fake.requests.length - before).toBe(1);
    const url = decodeURIComponent(fake.requests.at(-1)?.url ?? '');
    expect(url).toContain('status=in.(draft,sent,send_failed)');
    expect(url).toContain('request_type=eq.return_note');
    expect(url).toContain('select=invoice_access_key');
    expect(url).toContain(`invoice_access_key=in.("${first.request.invoiceAccessKey}","outra-chave")`);
  });

  it('sem chave perguntada, o conjunto é vazio e nenhuma requisição sai', async () => { // ADR-002
    const { fake, rest } = harness();
    expect((await supabaseSupplierRequestStore(rest).listOpenKeys('return_note', [])).size).toBe(0);
    expect(fake.requests).toEqual([]);
  });
});
