import { describe, expect, it } from 'vitest';
import { issueReturnNote } from '../../src/domain/index.js';
import { supabaseIssuedNoteStore } from '../../src/supplier/supabase-notes.js';
import { SOURCE_KEY, returnNote } from '../domain/supplier-request-fixtures.js';
import { harness } from './supabase-support.js';

// #156: a emissão mock sobre o PostgREST falso: a nota emitida é um fato (append-only), uma por devolução da fila.

const TABLE = 'issued_return_notes';
const DAY = '2026-11-12';

describe('#156 uma devolução da fila tem no máximo uma nota emitida', () => { // ADR-002
  it('a primeira emissão usa o id da tabela como sequência: ND-<id>, número <id>, série 9', async () => { // ADR-002
    const { fake, rest } = harness();
    const issued = await supabaseIssuedNoteStore(rest).issue(7, returnNote(), DAY);
    expect(issued).toEqual(issueReturnNote(returnNote(), { sequence: 1, issuedOn: DAY }));
    expect([issued.noteId, issued.number, issued.series]).toEqual(['ND-1', 1, 9]);
    expect(fake.rows(TABLE)).toHaveLength(1);
  });

  it('guarda a devolução, a nota de origem, o fornecedor, o dia e a nota montada; não guarda a chave nem o emitente', async () => { // ADR-002
    const { fake, rest } = harness();
    await supabaseIssuedNoteStore(rest).issue(7, returnNote(), DAY);
    const row = fake.rows(TABLE)[0]!;
    expect(row).toMatchObject({ queue_id: 7, invoice_access_key: SOURCE_KEY, supplier_id: 'F02', issued_on: DAY });
    expect(row.note).toMatchObject({ referencedAccessKey: SOURCE_KEY });
    expect(Object.keys(row).sort()).toEqual(['created_at', 'id', 'invoice_access_key', 'issued_on', 'note', 'queue_id', 'supplier_id']);
  });

  it('emitir de novo a mesma devolução devolve a mesma nota, com o mesmo número e a mesma chave, sem outra linha', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseIssuedNoteStore(rest);
    const first = await store.issue(7, returnNote(), DAY);
    const again = await store.issue(7, returnNote(), '2026-11-13');
    expect(again).toEqual(first);
    expect(again.accessKey).toBe(first.accessKey);
    expect(fake.rows(TABLE)).toHaveLength(1);
  });

  it('outra devolução recebe a sequência seguinte', async () => { // ADR-002
    const { rest } = harness();
    const store = supabaseIssuedNoteStore(rest);
    await store.issue(7, returnNote(), DAY);
    expect((await store.issue(8, returnNote(), DAY)).number).toBe(2);
  });

  it('a corrida: o insert que perde para a restrição única (nada volta) lê a nota que já existe', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseIssuedNoteStore(rest);
    const winner = await store.issue(7, returnNote(), DAY);
    // #156: a leitura prévia não acha nada, como se a outra emissão tivesse confirmado depois dela.
    fake.failNext(TABLE, 'GET', 200, []);
    const loser = await store.issue(7, returnNote(), DAY);
    expect(loser).toEqual(winner);
    expect(fake.rows(TABLE)).toHaveLength(1);
  });

  it('só lê e insere: nunca atualiza nem apaga uma nota emitida (a tabela é append-only)', async () => { // ADR-002
    const { fake, rest } = harness();
    const store = supabaseIssuedNoteStore(rest);
    await store.issue(7, returnNote(), DAY);
    await store.issue(7, returnNote(), DAY);
    expect(new Set(fake.requests.map((r) => r.method))).toEqual(new Set(['GET', 'POST']));
  });

  it('o insert usa a restrição da devolução e ignora a duplicada', async () => { // ADR-002
    const { fake, rest } = harness();
    await supabaseIssuedNoteStore(rest).issue(7, returnNote(), DAY);
    const post = fake.requests.find((r) => r.method === 'POST');
    expect(post?.url).toContain('on_conflict=queue_id');
    expect(post?.headers.Prefer).toContain('resolution=ignore-duplicates');
  });
});
