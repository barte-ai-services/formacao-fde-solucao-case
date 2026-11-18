import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from '../../src/cron/tick.js';
import { DockAction } from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { addReceipt, clearReceipts } from '../returns/acceptance.support.js';
import { awaiting, decide, returnFirstItem, type Row } from '../returns/supabase-decided-source.support.js';

// #9 O passo da devolução na rodada do Cron (#1/AC-6, AC-7, AC-8; #9/AC-2), sobre o kit e o PostgREST falso.

const ENV = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
const CRON = { cron: '*/15 * * * *' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** #9 O kit depois da primeira rodada (captura, proposta, regra): o que a regra aprovou já passou pela varredura. */
async function afterFirstRound() {
  const fake = new FakePostgrest(kitTables());
  vi.stubGlobal('fetch', fake.fetch);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await tick(CRON, ENV);
  return { fake, log, error, round: () => tick(CRON, ENV), queued: () => fake.rows('outbox_return_notes') };
}

const keyOf = (p: Row): string => String(p.invoice_access_key);
const queuedKeys = (rows: Row[]): string[] => rows.map((r) => String(r.invoice_access_key));
const returnFirst = (fake: FakePostgrest, p: Row): DockAction => returnFirstItem(fake, p);

describe('#9/AC-2 a rodada do Cron publica a devolução das decisões', () => {
  it('#1/AC-6 #9/AC-2: decisão pela regra sem devolução na fila entra na rodada seguinte', async () => {
    const { fake, round, queued } = await afterFirstRound();
    const e3 = awaiting(fake, 'E3');
    decide(fake, e3, { state: 'aprovada', action: returnFirst(fake, e3), decidedOn: '2026-11-15' });
    expect(queuedKeys(queued())).not.toContain(keyOf(e3));

    await round();

    expect(queuedKeys(queued())).toContain(keyOf(e3));
  });

  it('#1/AC-6 #9/AC-2: a linha de log da rodada traz quantas devoluções ela publicou', async () => {
    const { fake, log, round } = await afterFirstRound();
    const e3 = awaiting(fake, 'E3');
    decide(fake, e3, { state: 'aprovada', action: returnFirst(fake, e3), decidedOn: '2026-11-15' });
    log.mockClear();

    await round();

    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/devoluções publicadas 1\b/);
  });

  it('#1/AC-7 #9/AC-2: rodar de novo não duplica a devolução já publicada', async () => {
    const { fake, round, queued } = await afterFirstRound();
    const e3 = awaiting(fake, 'E3');
    decide(fake, e3, { state: 'aprovada', action: returnFirst(fake, e3), decidedOn: '2026-11-15' });
    await round();
    const before = queued().length;

    await round();

    expect(queued()).toHaveLength(before);
    expect(queuedKeys(queued()).filter((k) => k === keyOf(e3))).toHaveLength(1);
  });

  it('#1/AC-5 #9/AC-2: recusa decidida sem recebimento registrado não entra pela varredura', async () => {
    const { fake, round, queued } = await afterFirstRound();
    const note = awaiting(fake, 'E3');
    clearReceipts(fake, keyOf(note));
    decide(fake, note, { state: 'alterada', action: DockAction.refuse(), decidedOn: '2026-11-15' });

    await round();

    expect(queuedKeys(queued())).not.toContain(keyOf(note));
  });

  it('#1/AC-4 #9/AC-2: recusa decidida com recebimento anterior entra pela varredura', async () => {
    const { fake, round, queued } = await afterFirstRound();
    const note = awaiting(fake, 'E3');
    clearReceipts(fake, keyOf(note));
    const invoice = fake.rows('invoices').find((i) => i.access_key === keyOf(note));
    const [item] = invoice?.items as { supplierCode: string; quantity: { amount: number; unit: 'UN' | 'CX' } }[];
    addReceipt(fake, keyOf(note), '2026-11-14', [[item!.supplierCode, item!.quantity.amount, item!.quantity.unit]]);
    decide(fake, note, { state: 'alterada', action: DockAction.refuse(), decidedOn: '2026-11-15' });

    await round();

    expect(queuedKeys(queued())).toContain(keyOf(note));
  });

  it('#1/AC-8 #9/AC-2: receber, match, E4, E5, E6, E7 e E8 decididos não entram na fila', async () => {
    const { fake, round, queued } = await afterFirstRound();
    const keys: string[] = [];
    // #1/AC-8 Cada classe que não devolve, decidida com recusa e com recebimento já registrado (o caso que mais tentaria devolver).
    const classes = ['E4', 'E5', 'E6', 'E7', 'E8'];
    const pool = fake.rows('proposals').filter((p) => p.state === 'aguardando_aprovacao' && !['E1', 'E2', 'E3'].includes(String(p.classification)));
    classes.forEach((classification, i) => {
      const p = pool[i];
      if (!p) throw new Error('o kit não tem propostas para cobrir as classes');
      p.classification = classification;
      const invoice = fake.rows('invoices').find((n) => n.access_key === keyOf(p));
      const [item] = invoice?.items as { supplierCode: string; quantity: { amount: number; unit: 'UN' | 'CX' } }[];
      addReceipt(fake, keyOf(p), '2026-11-14', [[item!.supplierCode, item!.quantity.amount, item!.quantity.unit]], `RC-${classification}`);
      decide(fake, p, { state: 'aprovada', action: DockAction.refuse(), decidedOn: '2026-11-15' });
      keys.push(keyOf(p));
    });
    const e3 = awaiting(fake, 'E3');
    decide(fake, e3, { state: 'aprovada', action: DockAction.receive(), decidedOn: '2026-11-15' });
    keys.push(keyOf(e3));
    // #1/AC-8 O match também: decidido pela regra, com recebimento registrado.
    const match = fake.rows('proposals').find((p) => p.classification === 'MATCH' && p.state === 'aprovada');
    if (match) keys.push(keyOf(match));

    await round();

    expect(queuedKeys(queued()).filter((k) => keys.includes(k))).toEqual([]);
  });
});

describe('#9/AC-2 o teto de 20 publicações por rodada', () => {
  it('#9/AC-2: 25 decisões que devolvem entram 20 numa rodada e o resto na seguinte', async () => {
    const { fake, round, queued } = await afterFirstRound();
    const base = queued().length;
    const pool = fake.rows('proposals').filter((p) => p.state === 'aguardando_aprovacao');
    expect(pool.length).toBeGreaterThanOrEqual(25);
    for (const p of pool.slice(0, 25)) {
      p.classification = 'E3'; // #9 Só a classe importa para devolver; a quantidade vem da nota de cada proposta.
      decide(fake, p, { state: 'aprovada', action: returnFirst(fake, p), decidedOn: '2026-11-15' });
    }

    await round();
    expect(queued()).toHaveLength(base + 20);

    await round();
    expect(queued()).toHaveLength(base + 25);
  });
});

describe('#9/AC-2 a devolução que falha não derruba a rodada', () => {
  it('#9/AC-2: decisão com linha fora do formato falha o passo, sem repetir os dados, e a rodada segue e é registrada', async () => {
    const { fake, log, error, round } = await afterFirstRound();
    const secret = 'valor-secreto-do-banco';
    const e3 = awaiting(fake, 'E3');
    decide(fake, e3, { state: 'aprovada', action: returnFirst(fake, e3), decidedOn: '2026-11-15' });
    e3.classification = secret;
    const runsBefore = fake.rows('automation_runs').length;
    log.mockClear();
    error.mockClear();

    await expect(round()).resolves.not.toBeNull();

    const written = [...log.mock.calls, ...error.mock.calls].map((c) => String(c[0])).join('\n');
    expect(written).toMatch(/devoluções/);
    expect(written).not.toContain(secret);
    expect(fake.rows('automation_runs')).toHaveLength(runsBefore + 1);
    expect(fake.rows('automation_runs').at(-1)?.status).toBe('ok');
  });
});
