// #159 O módulo de paginação por cursor: puro, sem HTTP. Os testes das quatro listas estão em pagination.test.ts.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, MAX_LIMIT, MIN_LIMIT, pageOf, readPageQuery, sortedBy, type Ordering, type Page } from '../../src/http/page.js';

type Row = { group: number; name: string };

/** #159 Grupo do maior para o menor, depois o nome: a mesma forma da fila (nível, valor, chave). */
const byGroupThenName: Ordering<Row> = {
  list: 'teste',
  shape: ['number', 'string'],
  key: (r) => [-r.group, r.name],
};

const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ group: i % 3, name: `r${String(i).padStart(3, '0')}` }));

const params = (query: string) => new URLSearchParams(query);

describe('readPageQuery', () => {
  it('#159/AC-1 sem cursor e sem limite, a lista inteira', () => {
    expect(readPageQuery(params(''))).toEqual({ kind: 'whole' });
    expect(readPageQuery(params('dia=2026-11-15'))).toEqual({ kind: 'whole' });
  });

  it('#159/AC-1 o limite padrão é 30 e a faixa é de 25 a 50', () => {
    expect([DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT]).toEqual([30, 25, 50]);
    expect(readPageQuery(params('cursor=abc'))).toMatchObject({ kind: 'page', limit: 30, cursor: 'abc' });
    expect(readPageQuery(params('limite=25'))).toEqual({ kind: 'page', limit: 25, cursor: null });
    expect(readPageQuery(params('limite=50'))).toEqual({ kind: 'page', limit: 50, cursor: null });
  });

  it.each(['24', '51', '10', 'abc', '', '30.5', '-30', '1e2', '0x20', ' 30'])('#159/AC-3 limite %j é recusado com limite_invalido', async (value) => {
    const result = readPageQuery(params(`limite=${encodeURIComponent(value)}`));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: 'limite_invalido' });
  });
});

describe('sortedBy e pageOf', () => {
  it('#159/AC-2 ordena pela tupla e não muda a lista recebida', () => {
    const input = rows(7);
    const copy = [...input];
    const sorted = sortedBy(input, byGroupThenName);
    expect(input).toEqual(copy);
    expect(sorted.map((r) => r.group)).toEqual([2, 2, 1, 1, 0, 0, 0]);
    expect(sorted[0]).toEqual({ group: 2, name: 'r002' });
  });

  it('#159/AC-2 percorrer os cursores devolve cada item uma vez, na ordem da lista inteira', () => {
    const sorted = sortedBy(rows(70), byGroupThenName);
    const seen: Row[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<Row> | null = pageOf(byGroupThenName, sorted, { cursor, limit: 30 });
      expect(page).not.toBeNull();
      if (!page) return;
      sizes.push(page.items.length);
      expect(page.total).toBe(70);
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(sizes).toEqual([30, 30, 10]);
    expect(seen).toEqual(sorted);
  });

  it('#159/AC-1 lista que cabe numa página termina com nextCursor nulo; lista vazia também', () => {
    const sorted = sortedBy(rows(30), byGroupThenName);
    expect(pageOf(byGroupThenName, sorted, { cursor: null, limit: 30 })).toMatchObject({ nextCursor: null, total: 30 });
    expect(pageOf(byGroupThenName, [], { cursor: null, limit: 30 })).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it('#159/AC-2 um item decidido entre duas páginas não faz outro pular nem repetir', () => {
    const sorted = sortedBy(rows(70), byGroupThenName);
    const first = pageOf(byGroupThenName, sorted, { cursor: null, limit: 30 });
    expect(first?.nextCursor).not.toBeNull();
    const decided = sorted[0]; // #159/AC-2 sai da lista depois de a primeira página ser entregue
    const after = sorted.filter((r) => r !== decided);
    const second = pageOf(byGroupThenName, after, { cursor: first?.nextCursor ?? null, limit: 30 });
    expect(second?.items).toEqual(sorted.slice(30, 60));
    expect(second?.total).toBe(69);
  });

  it('#159/AC-2 itens que empatam nos primeiros campos seguem a ordem do desempate', () => {
    const tied: Row[] = Array.from({ length: 60 }, (_, i) => ({ group: 1, name: `n${String(59 - i).padStart(2, '0')}` }));
    const sorted = sortedBy(tied, byGroupThenName);
    expect(sorted.map((r) => r.name)).toEqual([...sorted.map((r) => r.name)].sort());
    const first = pageOf(byGroupThenName, sorted, { cursor: null, limit: 25 });
    const second = pageOf(byGroupThenName, sorted, { cursor: first?.nextCursor ?? null, limit: 25 });
    expect(second?.items[0]).toEqual(sorted[25]);
  });

  it('#159/AC-3 o cursor é opaco: base64url, sem o valor da chave à vista', () => {
    const sorted = sortedBy(rows(70), byGroupThenName);
    const cursor = pageOf(byGroupThenName, sorted, { cursor: null, limit: 30 })?.nextCursor ?? '';
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(sorted[29]?.name ?? '?');
  });

  const sorted = sortedBy(rows(70), byGroupThenName);
  const good = pageOf(byGroupThenName, sorted, { cursor: null, limit: 30 })?.nextCursor ?? '';
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  it.each([
    ['texto que não é base64', '%%%'],
    ['base64 que não é JSON', Buffer.from('não sou json').toString('base64url')],
    ['JSON que não é objeto', encode([1, 2])],
    ['versão desconhecida', encode({ v: 2, l: 'teste', k: [0, 'r001'] })],
    ['lista de outro nome', encode({ v: 1, l: 'outra', k: [0, 'r001'] })],
    ['tupla curta', encode({ v: 1, l: 'teste', k: [0] })],
    ['tupla com tipo trocado', encode({ v: 1, l: 'teste', k: ['0', 1] })],
    ['tupla com objeto', encode({ v: 1, l: 'teste', k: [0, { a: 1 }] })],
    ['cursor adulterado', `${good.slice(0, -2)}xx`],
  ])('#159/AC-3 cursor inválido (%s) dá nulo', (_name, cursor) => {
    expect(pageOf(byGroupThenName, sorted, { cursor, limit: 30 })).toBeNull();
  });

  it('#159/AC-3 o cursor de uma lista não serve noutra', () => {
    const other: Ordering<Row> = { ...byGroupThenName, list: 'outra' };
    expect(pageOf(other, sorted, { cursor: good, limit: 30 })).toBeNull();
  });
});
