import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPPLIER_SWEEP_PER_ROUND } from '../../src/cron/supplier-sweep.js';
import { tick } from '../../src/cron/tick.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { sentRow } from '../supplier/supabase-reply-support.js';
import { invoiceRow } from '../supplier/supabase-support.js';

// #157: o passo da varredura do prazo dos pedidos ao fornecedor (#157) na rodada do Cron, sobre o kit e o PostgREST falso.

const ENV = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
// #356 Sem `scheduledTime` a rodada é manual (sem o ritmo do modo); cada rodada orçada executa só o que cabe nos 50, e o passo adiado passa à frente na seguinte.
const CRON = { cron: '* * * * *' };
const ROUNDS = 3;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function round(today: string, requests = 1): { fake: FakePostgrest; run: () => Promise<void>; once: () => Promise<unknown> } {
  const sent = Array.from({ length: requests }, (_, index) => sentRow(index + 1));
  const fake = new FakePostgrest({ ...kitTables(), invoices: [invoiceRow()], outbox_supplier_emails: sent });
  fake.unique('supplier_reply_readings', ['request_id'], (row) => row.message_id === null || row.message_id === undefined);
  vi.stubGlobal('fetch', fake.fetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${today}T15:00:00Z`));
  const run = async (): Promise<void> => {
    for (let i = 0; i < ROUNDS; i += 1) await tick(CRON, ENV);
  };
  return { fake, run, once: () => tick(CRON, ENV) };
}

describe('#157 a rodada do Cron varre o prazo dos pedidos ao fornecedor, mesmo sem o Claude', () => {
  it('#157: sem credencial do Claude, o pedido enviado depois do prazo vira no_reply com follow_up, e a regra deixa o rascunho da cobrança na mesma varredura', async () => {
    const { fake, run } = round('2026-11-18');

    await run();

    expect(fake.rows('supplier_reply_readings')).toHaveLength(1);
    expect(fake.rows('supplier_reply_readings')[0]).toMatchObject({ request_id: 1, message_id: null, reply_outcome: 'no_reply', next_step: 'follow_up' });
    expect(fake.rows('outbox_supplier_emails')[0]?.follow_up_draft).toMatchObject({ dueOn: '2026-11-23', body: expect.stringContaining('{{cobranca.prazo}}') });
  });

  it('#157: a rodada seguinte não marca de novo (a varredura é idempotente)', async () => {
    const { fake, run } = round('2026-11-18');
    await run();

    await run();

    expect(fake.rows('supplier_reply_readings')).toHaveLength(1);
  });

  it('#157: no dia do prazo ainda está no prazo: a rodada não marca nada', async () => {
    const { fake, run } = round('2026-11-17');

    await run();

    expect(fake.rows('supplier_reply_readings')).toHaveLength(0);
  });
});

describe('#157 a varredura do prazo tem teto por rodada, para caber nas subrequests do Worker', () => {
  it('#157 #356: com vários pedidos atrasados, cada rodada marca no máximo o teto (SUPPLIER_SWEEP_PER_ROUND) e as seguintes marcam os outros', async () => {
    const { fake, once } = round('2026-11-18', 3);
    let previous = 0;
    for (let i = 0; i < 12 && fake.rows('supplier_reply_readings').length < 3; i += 1) {
      await once();
      const marked = fake.rows('supplier_reply_readings').length;
      expect(marked - previous).toBeLessThanOrEqual(SUPPLIER_SWEEP_PER_ROUND);
      previous = marked;
    }
    expect(fake.rows('supplier_reply_readings').map((row) => row.request_id).sort()).toEqual([1, 2, 3]);
  });

  it('#157: o teto da varredura é 1 pedido por rodada', () => {
    expect(SUPPLIER_SWEEP_PER_ROUND).toBe(1);
  });
});
