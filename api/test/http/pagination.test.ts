/** #159 As quatro listas (fila, hoje, duplicadas, doca) paginam por cursor, com 70 itens cada. O mesmo contrato roda nas quatro: forma (AC-1), percurso (AC-2), recusas (AC-3) e agregados (AC-4). */
import { describe, expect, it } from 'vitest';
import { MemoryApprovalStore, type CaseFile } from '../../src/approval/store.js';
import { draftProposal, propose } from '../../src/domain/approval.js';
import { ApprovalPolicy } from '../../src/domain/approval-policy.js';
import { Invoice, Money, Title } from '../../src/domain/index.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { wmsDockActionOutbox } from '../../src/connectors/wms-dock-action.js';
import { appStoreActionOutbox } from '../../src/connectors/store-action.js';
import { DockAction } from '../../src/domain/index.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import type { DuplicateEntry } from '../../src/http/duplicates.js';
import { createWorker } from '../../src/index.js';
import { checkedWith, kitInvoice, kitSupplier } from '../approval/kit.js';
import { invoiceRow, kitNotesOf } from '../dock/kit-invoices.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

const TODAY = '2026-11-15';
const DOCK_DAY = '2026-11-11';
const ANALISTA = 'analista@jachegou.test';
const TOTAL_ITEMS = 70;

const env: Env = {
  ACCESS_AUD: 'aud',
  ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com',
  APPROVER_LEVELS: JSON.stringify({ [ANALISTA]: 'analista', 'diretoria@jachegou.test': 'diretoria' }),
  BARTE_ACADEMY_SUPABASE_URL: 'https://supabase.test',
  BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_teste',
};
// #159 O Worker só chama `waitUntil`; `passThroughOnException` e `props` completam o tipo e o teste não os lê, e o compilador não vê isso, por isso a asserção dupla.
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const verifier: AccessVerifier = { verify: async (token) => ({ ok: true, identity: { email: token } }) };

/** #159 Embaralha de forma fixa (37 é primo com 70), para que a ordem de inserção não seja a ordem da lista. */
const shuffled = <T>(items: readonly T[]): T[] => items.map((_, i) => items[(i * 37) % items.length] as T);

type Get = (query: string) => Promise<Response>;
type Item = Record<string, unknown>;
type Whole = Record<string, unknown>;

type Lane = {
  name: string;
  /** #159 Monta o mundo com 70 itens e devolve a chamada GET da rota com a query dada. */
  arrange: () => Promise<Get>;
  /** #159 Os campos da resposta de hoje, sem cursor nem limite. */
  oldKeys: string[];
  /** #159 Os campos de contexto que a resposta paginada repete. */
  context: string[];
  itemsOf: (whole: Whole) => Item[];
  keyOf: (item: Item) => string;
  /** #159 A ordem documentada, conferida sem usar o módulo de paginação. */
  ordered: (items: Item[]) => boolean;
  /** #159 Os agregados esperados, calculados sobre a lista inteira de hoje. */
  aggregates: (whole: Whole) => Record<string, unknown>;
};

function queueInvoice(i: number, classes: Parameters<typeof checkedWith>[1][]): CaseFile {
  const template = kitInvoice('NF-008');
  const invoice = Invoice.receive({
    accessKey: `35261100000000000000550010000000${String(i).padStart(3, '0')}1000000000`,
    number: String(1000 + i),
    series: '1',
    supplierId: template.supplierId,
    store: template.store,
    issuedOn: '2026-11-11',
    purchaseOrderRef: null,
    entryChannel: 'SEFAZ',
    items: template.items,
    total: Money.ofCents(500000 + i * 137),
  });
  checkedWith(invoice, ...classes);
  const supplier = kitSupplier(invoice.supplierId);
  const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: '2026-12-10' });
  const route = ApprovalPolicy.route(invoice, supplier);
  // #159 Valores em risco repetidos de propósito: o desempate pela chave precisa decidir a ordem.
  const draft = { ...draftProposal(invoice, null), amountAtRisk: Money.ofCents(((i % 5) + 1) * 10000) };
  const { proposal, approval } = propose(invoice, title, { route, ...draft, today: TODAY });
  return { invoice, proposal, title, route, approval, supplierBlocked: supplier?.paymentBlocked ?? false };
}

const approvalWorker = (store: MemoryApprovalStore) =>
  createWorker({ verifier, approval: { store, today: () => TODAY } });
const callAs = (worker: ReturnType<typeof createWorker>, path: string, as: string, method = 'GET') =>
  worker.fetch(new Request(`https://worker.test${path}`, { method, headers: { 'Cf-Access-Jwt-Assertion': as } }), env, ctx);

const LEVEL_RANK: Record<string, number> = { bloqueio: 4, diretoria: 3, coordenacao: 2, analista: 1, regra: 0 };

const queueLane: Lane = {
  name: 'fila',
  async arrange() {
    const classes = [['E4'], ['E5'], ['E6'], ['E4', 'E5']] as const;
    const files = Array.from({ length: TOTAL_ITEMS }, (_, i) => queueInvoice(i, [...(classes[i % classes.length] ?? ['E4'])]));
    const worker = approvalWorker(new MemoryApprovalStore(shuffled(files)));
    return (query) => callAs(worker, `/api/fila${query}`, ANALISTA);
  },
  oldKeys: ['approver', 'items'],
  context: ['approver'],
  itemsOf: (whole) => whole.items as Item[],
  keyOf: (item) => item.invoiceAccessKey as string,
  ordered: (items) =>
    items.every((item, i) => {
      const prev = items[i - 1];
      if (!prev) return true;
      const level = (x: Item) => LEVEL_RANK[x.level as string] ?? -1;
      const risk = (x: Item) => (x.amountAtRisk as { cents: number }).cents;
      if (level(prev) !== level(item)) return level(prev) > level(item);
      if (risk(prev) !== risk(item)) return risk(prev) > risk(item);
      return (prev.invoiceAccessKey as string) < (item.invoiceAccessKey as string);
    }),
  aggregates: (whole) => {
    const items = whole.items as Item[];
    return {
      approvable: items.filter((i) => i.canApprove === true).length,
      amountAtRisk: { cents: items.reduce((sum, i) => sum + (i.amountAtRisk as { cents: number }).cents, 0) },
      blocked: items.filter((i) => i.level === 'bloqueio').length,
    };
  },
};

const todayLane: Lane = {
  name: 'hoje',
  async arrange() {
    const files: CaseFile[] = [];
    for (let i = 0; i < TOTAL_ITEMS; i++) {
      // #159 Metade passa pela regra (match), metade espera uma pessoa e é aprovada abaixo.
      files.push(i % 2 === 0 ? matchCase(i) : queueInvoice(i, ['E4']));
    }
    const worker = approvalWorker(new MemoryApprovalStore(shuffled(files)));
    for (const f of files.filter((x) => x.proposal.state === 'aguardando_aprovacao')) {
      const res = await callAs(worker, `/api/propostas/${f.invoice.accessKey}/aprovar`, 'diretoria@jachegou.test', 'POST');
      if (res.status !== 200) throw new Error(`arranjo: aprovar ${f.invoice.accessKey} deu ${res.status}`);
    }
    return (query) => callAs(worker, `/api/hoje${query}`, ANALISTA);
  },
  oldKeys: ['day', 'items', 'total'],
  context: ['day'],
  itemsOf: (whole) => whole.items as Item[],
  keyOf: (item) => item.invoiceAccessKey as string,
  ordered: (items) => items.every((item, i) => i === 0 || (items[i - 1]?.invoiceAccessKey as string) < (item.invoiceAccessKey as string)),
  aggregates: (whole) => {
    const items = whole.items as Item[];
    return {
      toPay: { cents: (whole.total as { cents: number }).cents },
      approvedByRule: items.filter((i) => i.approvedBy === 'rule').length,
    };
  },
};

function matchCase(i: number): CaseFile {
  const file = queueInvoice(i, []);
  return file; // #159 sem divergência a nota é match: nível regra, aprovada pela regra no ato de propor
}

function duplicateEntry(i: number): DuplicateEntry {
  const cents = 100000 + i * 211;
  return {
    duplicate: {
      accessKey: `35261100000000000000550010000009${String(i).padStart(3, '0')}1000000000`,
      number: String(9000 + i),
      supplierId: 'F03',
      issuedOn: '2026-11-11',
      total: Money.ofCents(cents),
    },
    original: i % 2 === 0 ? { accessKey: `orig-${i}`, number: String(100 + i), status: 'lançada' } : null,
    reason: i % 2 === 0 ? 'titulo_lancado' : 'ordem_sem_saldo',
    blockedAmount: Money.ofCents(cents),
    titleState: i % 3 === 0 ? 'bloqueado' : null,
  };
}

const duplicatesLane: Lane = {
  name: 'duplicadas',
  async arrange() {
    const entries = shuffled(Array.from({ length: TOTAL_ITEMS }, (_, i) => duplicateEntry(i)));
    const worker = createWorker({ verifier, duplicates: () => ({ list: async () => entries }) });
    return (query) => callAs(worker, `/api/duplicates${query}`, ANALISTA);
  },
  oldKeys: ['count', 'duplicates'],
  context: [],
  itemsOf: (whole) => whole.duplicates as Item[],
  keyOf: (item) => (item.duplicate as { accessKey: string }).accessKey,
  ordered: (items) =>
    items.every((item, i) => i === 0 || (items[i - 1]?.duplicate as { accessKey: string }).accessKey < (item.duplicate as { accessKey: string }).accessKey),
  aggregates: (whole) => {
    const items = whole.duplicates as Item[];
    const by = (reason: string) => items.filter((i) => i.reason === reason).length;
    return {
      blockedAmount: { cents: items.reduce((sum, i) => sum + (i.blockedAmountCents as number), 0) },
      byReason: { titulo_lancado: by('titulo_lancado'), ordem_sem_saldo: by('ordem_sem_saldo') },
    };
  },
};

/** #159 A doca do CD e o recebimento na loja são o mesmo handler, com duas listas: cada uma com a sua. */
function dockLaneOf(name: string, path: string, destination: string): Lane {
  return {
    name,
    async arrange() {
      const [base] = kitNotesOf('CD-03', DOCK_DAY);
      if (!base) throw new Error('arranjo: o kit não tem nota do CD-03 em 2026-11-11');
      // #159 Números de 1 a 3 dígitos, para que a ordem numérica difira da alfabética.
      const notes = Array.from({ length: TOTAL_ITEMS }, (_, i) => ({
        ...base,
        chave: `35261100000000000000550010000008${String(i).padStart(3, '0')}1000000000`,
        numero: 5 + i * 3,
        destino: destination,
        data_emissao: DOCK_DAY,
      }));
      const fake = new FakePostgrest({ invoices: shuffled(notes).map(invoiceRow) });
      const rest = new SupabaseRest({ url: 'https://supabase.test', secretKey: 'sb_teste', fetch: fake.fetch });
      for (const note of notes.filter((_, i) => i % 7 === 0)) {
        const action = DockAction.receive();
        if (destination.startsWith('LJ-')) await appStoreActionOutbox(rest).publish({ invoiceAccessKey: note.chave, store: destination, action });
        else await wmsDockActionOutbox(rest).publish({ invoiceAccessKey: note.chave, action });
      }
      const worker = createWorker({ verifier, dock: { supabase: () => rest, today: () => DOCK_DAY } });
      return (query) => callAs(worker, `${path}${query}`, 'doca@jachegou.test');
    },
    oldKeys: ['awaiting', 'date', 'destination', 'destinations', 'rows'],
    context: ['date', 'destination', 'destinations'],
    itemsOf: (whole) => whole.rows as Item[],
    keyOf: (item) => item.invoiceAccessKey as string,
    ordered: (items) => items.every((item, i) => i === 0 || Number(items[i - 1]?.number) < Number(item.number)),
    aggregates: (whole) => ({ awaiting: whole.awaiting }),
  };
}

const dockLane = dockLaneOf('doca', '/api/doca', 'CD-03');
const storeLane = dockLaneOf('recebimento-loja', '/api/recebimento-loja', 'LJ-012');

type Paged = { items: Item[]; nextCursor: string | null; total: number; aggregates: Record<string, unknown> } & Record<string, unknown>;

const sep = (query: string) => (query === '' ? '' : `?${query}`);

async function pageAt(get: Get, query: string): Promise<Paged> {
  const res = await get(sep(query));
  expect(res.status).toBe(200);
  return (await res.json()) as Paged;
}

async function walk(get: Get, limit: number): Promise<Paged[]> {
  const pages: Paged[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? `limite=${limit}` : `cursor=${encodeURIComponent(cursor)}&limite=${limit}`;
    const page = await pageAt(get, query);
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null && pages.length < 10);
  return pages;
}

describe.each([queueLane, todayLane, duplicatesLane, dockLane, storeLane])('#159 lista $name', (lane) => {
  const arranged = lane.arrange();
  const wholeOf = async (get: Get) => (await (await get('')).json()) as Whole;

  it('sem cursor e sem limite responde como antes: a lista inteira, na forma antiga', async () => {
    const get = await arranged;
    const whole = await wholeOf(get);
    expect(Object.keys(whole).sort()).toEqual([...lane.oldKeys].sort());
    expect(lane.itemsOf(whole)).toHaveLength(TOTAL_ITEMS);
  });

  it('#159/AC-1 aceita cursor e limite e devolve items, nextCursor e total (limite 30 de início)', async () => {
    const get = await arranged;
    const page = await pageAt(get, 'limite=30');
    expect(Object.keys(page).sort()).toEqual(['aggregates', 'items', 'nextCursor', 'total', ...lane.context].sort());
    expect(page.items).toHaveLength(30);
    expect(typeof page.nextCursor).toBe('string');
    expect(page.total).toBe(TOTAL_ITEMS);
  });

  it('#159/AC-1 com cursor e sem limite, o limite é 30', async () => {
    const get = await arranged;
    const first = await pageAt(get, 'limite=30');
    const second = await pageAt(get, `cursor=${encodeURIComponent(first.nextCursor ?? '')}`);
    expect(second.items).toHaveLength(30);
    expect(second.total).toBe(TOTAL_ITEMS);
  });

  it.each([25, 50])('#159/AC-1 o limite %i, o extremo da faixa, é aceito', async (limit) => {
    const get = await arranged;
    const page = await pageAt(get, `limite=${limit}`);
    expect(page.items).toHaveLength(limit);
  });

  it('#159/AC-2 percorrer os cursores devolve cada item uma vez, na ordem documentada da lista', async () => {
    const get = await arranged;
    const whole = lane.itemsOf(await wholeOf(get)).map(lane.keyOf);
    const pages = await walk(get, 30);
    const walked = pages.flatMap((p) => p.items);
    expect(pages.map((p) => p.items.length)).toEqual([30, 30, 10]);
    expect(lane.ordered(walked)).toBe(true);
    expect(walked.map(lane.keyOf).sort()).toEqual([...whole].sort());
    expect(new Set(whole).size).toBe(TOTAL_ITEMS);
    expect(pages.map((p) => p.nextCursor)).toEqual([expect.any(String), expect.any(String), null]);
    expect(pages.map((p) => p.total)).toEqual([TOTAL_ITEMS, TOTAL_ITEMS, TOTAL_ITEMS]);
  });

  it('#159/AC-2 o mesmo vale com o limite 50 e com o 25', async () => {
    const get = await arranged;
    const reference = (await walk(get, 30)).flatMap((p) => p.items.map(lane.keyOf));
    for (const limit of [25, 50]) {
      const pages = await walk(get, limit);
      expect(pages.flatMap((p) => p.items.map(lane.keyOf))).toEqual(reference);
    }
  });

  it.each([
    ['cursor adulterado', (good: string) => `${good.slice(0, -3)}AAA`],
    ['cursor que não é base64', () => '%%%'],
    ['cursor de texto qualquer', () => 'segredo-interno'],
    ['cursor vazio', () => ''],
  ])('#159/AC-3 %s devolve 400 com cursor_invalido e mais nada', async (_name, bad) => {
    const get = await arranged;
    const first = await pageAt(get, 'limite=30');
    const sent = bad(first.nextCursor ?? '');
    const res = await get(`?cursor=${encodeURIComponent(sent)}`);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'cursor_invalido' });
    if (sent !== '') expect(text).not.toContain(sent);
  });

  it('#159/AC-3 o cursor de outra lista devolve 400 com cursor_invalido', async () => {
    const get = await arranged;
    const lanes = [queueLane, todayLane, duplicatesLane, dockLane, storeLane].filter((l) => l !== lane);
    for (const other of lanes) {
      const otherGet = await other.arrange();
      const foreign = (await pageAt(otherGet, 'limite=30')).nextCursor ?? '';
      const res = await get(`?cursor=${encodeURIComponent(foreign)}`);
      expect(res.status, `cursor da lista ${other.name}`).toBe(400);
      expect(await res.json()).toEqual({ error: 'cursor_invalido' });
    }
  });

  it.each(['24', '51', 'abc', '10', '', '30.5', '-1'])('#159/AC-3 limite %j devolve 400 com limite_invalido e mais nada', async (value) => {
    const get = await arranged;
    const res = await get(`?limite=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'limite_invalido' });
    if (value !== '') expect(text).not.toContain(value);
  });

  it('#159/AC-4 os agregados são os mesmos em todas as páginas e iguais aos da lista inteira', async () => {
    const get = await arranged;
    const whole = await wholeOf(get);
    const expected = lane.aggregates(whole);
    const pages = await walk(get, 30);
    for (const page of pages) {
      expect(page.aggregates).toMatchObject(expected);
      expect(page.aggregates).toEqual(pages[0]?.aggregates);
      for (const key of lane.context) expect(page[key]).toEqual(whole[key]);
    }
    // #159 Os dinheiros dos agregados trazem o texto em reais, como o resto da API.
    for (const value of Object.values(pages[0]?.aggregates ?? {})) {
      if (typeof value === 'object' && value !== null && 'cents' in value) expect(value).toHaveProperty('text', expect.stringMatching(/^R\$/));
    }
  });

  it('#159/AC-4 uma página menor ou maior não muda os agregados', async () => {
    const get = await arranged;
    const small = await pageAt(get, 'limite=25');
    const large = await pageAt(get, 'limite=50');
    expect(small.aggregates).toBeTypeOf('object');
    expect(small.aggregates).toEqual(large.aggregates);
  });
});

describe('#159 contexto específico das listas', () => {
  it('#159/AC-4 a fila diz quantas a pessoa pode aprovar e o nível dela, em todas as páginas', async () => {
    const get = await queueLane.arrange();
    const pages = await walk(get, 30);
    const approvable = pages.reduce((sum, p) => sum + p.items.filter((i) => i.canApprove === true).length, 0);
    for (const page of pages) {
      expect(page.aggregates.approvable).toBe(approvable);
      expect(page.approver).toMatchObject({ level: 'analista' });
    }
  });

  it('#159/AC-1 a lista do dia continua com total em centavos sem cursor e vira contagem com cursor', async () => {
    const get = await todayLane.arrange();
    const old = (await (await get('')).json()) as { total: { cents: number } };
    const page = await pageAt(get, 'limite=30');
    expect(typeof old.total.cents).toBe('number');
    expect(page.total).toBe(TOTAL_ITEMS);
    expect((page.aggregates.toPay as { cents: number }).cents).toBe(old.total.cents);
  });

  it('#159/AC-4 os itens da lista do dia paginada trazem a exceção e quem aprovou, e approvedByRule conta a regra', async () => {
    const get = await todayLane.arrange();
    const page = await pageAt(get, 'limite=50');
    const items = page.items as Item[];
    expect(items.every((i) => typeof i.exceptionName === 'string' && typeof i.exceptionCode === 'string')).toBe(true);
    expect(new Set(items.map((i) => i.approvedBy))).toEqual(new Set(['rule', 'person']));
    expect(page.aggregates.approvedByRule).toBe(TOTAL_ITEMS / 2);
  });

  it('#159/AC-1 a doca paginada respeita destino e data da query', async () => {
    const get = await dockLane.arrange();
    const page = await pageAt(get, `destino=CD-03&data=${DOCK_DAY}&limite=25`);
    expect(page).toMatchObject({ destination: 'CD-03', date: DOCK_DAY });
    expect(page.items).toHaveLength(25);
  });
});

/** #159 Sem cursor nem limite, cada lista sai na ordem em que a loja a devolve: a ordem antiga é contrato. */
describe('#159 modo inteiro: a ordem é a da loja, não a da paginação', () => {
  const keysOf = (items: Item[]) => items.map((i) => i.invoiceAccessKey as string);
  const keyOfIndex = (i: number) => queueInvoice(i, ['E4']).invoice.accessKey;

  it('#159/AC-2 a fila inteira sai na ordem da loja, mesmo fora da ordem do nível e do valor em risco', async () => {
    const order = [3, 1, 2, 0, 4];
    const worker = approvalWorker(new MemoryApprovalStore(order.map((i) => queueInvoice(i, ['E4']))));
    const whole = (await (await callAs(worker, '/api/fila', ANALISTA)).json()) as Whole;
    expect(keysOf(whole.items as Item[])).toEqual(order.map(keyOfIndex));
  });

  it('#159/AC-2 a lista do dia inteira sai na ordem da loja, mesmo fora da ordem da chave de acesso', async () => {
    const order = [5, 2, 9, 1];
    const worker = approvalWorker(new MemoryApprovalStore(order.map((i) => matchCase(i))));
    const whole = (await (await callAs(worker, '/api/hoje', ANALISTA)).json()) as Whole;
    expect(keysOf(whole.items as Item[])).toEqual(order.map(keyOfIndex));
  });

  it('#159/AC-2 as duplicadas inteiras saem na ordem da leitura, mesmo fora da ordem da chave', async () => {
    const order = [7, 3, 5];
    const entries = order.map((i) => duplicateEntry(i));
    const worker = createWorker({ verifier, duplicates: () => ({ list: async () => entries }) });
    const whole = (await (await callAs(worker, '/api/duplicates', ANALISTA)).json()) as Whole;
    const keys = (whole.duplicates as Item[]).map((i) => (i.duplicate as { accessKey: string }).accessKey);
    expect(keys).toEqual(entries.map((e) => e.duplicate.accessKey));
  });
});

/** #159/AC-3 O cursor é preso à lista e aos filtros com que foi emitido: com outro filtro, é cursor inválido. */
describe('#159 o cursor fica preso aos filtros', () => {
  const refused = async (res: Response) => {
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'cursor_invalido' });
  };
  const withCursor = (cursor: string | null, extra: string) => `?cursor=${encodeURIComponent(cursor ?? '')}${extra}`;

  it('#159/AC-3 hoje: o cursor de um dia usado em outro dia devolve 400 cursor_invalido', async () => {
    const get = await todayLane.arrange();
    const first = await pageAt(get, `dia=${TODAY}&limite=25`);
    await refused(await get(withCursor(first.nextCursor, '&dia=2026-11-14')));
  });

  it('#159/AC-3 hoje: o dia padrão e o mesmo dia pedido por extenso são o mesmo filtro', async () => {
    const get = await todayLane.arrange();
    const first = await pageAt(get, 'limite=25');
    const second = await get(withCursor(first.nextCursor, `&dia=${TODAY}`));
    expect(second.status).toBe(200);
  });

  it.each([
    ['doca', dockLaneOf('doca', '/api/doca', 'CD-03'), 'destino', 'CD-03', 'CD-04'],
    ['recebimento-loja', dockLaneOf('recebimento-loja', '/api/recebimento-loja', 'LJ-012'), 'loja', 'LJ-012', 'LJ-013'],
  ])('#159/AC-3 %s: o cursor de um destino ou de uma data, usado com outro, devolve 400 cursor_invalido', async (_name, lane, param, shown, other) => {
    const get = await lane.arrange();
    const first = await pageAt(get, `${param}=${shown}&data=${DOCK_DAY}&limite=25`);
    await refused(await get(withCursor(first.nextCursor, `&${param}=${other}&data=${DOCK_DAY}`)));
    await refused(await get(withCursor(first.nextCursor, `&${param}=${shown}&data=2026-11-12`)));
    const same = await get(withCursor(first.nextCursor, `&${param}=${shown}&data=${DOCK_DAY}`));
    expect(same.status).toBe(200);
  });

  it.each([
    ['doca', dockLaneOf('doca', '/api/doca', 'CD-03'), 'destino', 'CD-03'],
    ['recebimento-loja', dockLaneOf('recebimento-loja', '/api/recebimento-loja', 'LJ-012'), 'loja', 'LJ-012'],
  ])('#159/AC-3 %s: sem destino explícito, o cursor vale para o destino que o servidor escolheu', async (_name, lane, param, shown) => {
    const get = await lane.arrange();
    const first = await pageAt(get, 'limite=25');
    expect(first.destination).toBe(shown);
    const implicit = await get(withCursor(first.nextCursor, ''));
    expect(implicit.status).toBe(200);
    const explicit = await get(withCursor(first.nextCursor, `&${param}=${shown}`));
    expect(explicit.status).toBe(200);
  });

  it('#159/AC-3 a fila e as duplicadas não têm filtro: o mesmo cursor segue válido', async () => {
    for (const lane of [queueLane, duplicatesLane]) {
      const get = await lane.arrange();
      const first = await pageAt(get, 'limite=25');
      expect((await get(withCursor(first.nextCursor, '&limite=30'))).status, lane.name).toBe(200);
    }
  });
});
