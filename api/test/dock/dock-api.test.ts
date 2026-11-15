import { describe, expect, it, vi } from 'vitest';
import type { AccessVerifier } from '../../src/http/access.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { wmsDockActionOutbox } from '../../src/connectors/wms-dock-action.js';
import type { DockActionView } from '../../src/dock/dock-board.js';
import { DockAction, Quantity } from '../../src/domain/index.js';
import type { PartialLine, Unit } from '../../src/domain/index.js';
import type { Env } from '../../src/env.js';
import { createWorker } from '../../src/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitInvoiceRows, kitNotes, kitNotesOf } from './kit-invoices.js';

const ACCESS: Env = { ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com' };
const SUPABASE: Env = { BARTE_ACADEMY_SUPABASE_URL: 'https://supabase.test', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_teste' };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

// #72 Verificador fake: aceita qualquer token, sem rede (o Access tem os próprios testes em access.test.ts).
const verifier: AccessVerifier = { verify: async () => ({ ok: true, identity: { email: 'doca@jachegou.test' } }) };

const cd03 = kitNotesOf('CD-03', '2026-11-11');

function setup(options: { today?: string } = {}) {
  const fake = new FakePostgrest({ invoices: kitInvoiceRows() });
  const rest = new SupabaseRest({ url: 'https://supabase.test', secretKey: 'sb_teste', fetch: fake.fetch });
  const worker = createWorker({
    verifier,
    dock: {
      supabase: (env) => (env.BARTE_ACADEMY_SUPABASE_URL ? rest : null),
      today: () => options.today ?? '2026-11-11',
    },
  });
  const get = (path: string, env: Env = { ...ACCESS, ...SUPABASE }, method = 'GET') =>
    worker.fetch(new Request(`https://worker.test${path}`, { method, headers: { 'Cf-Access-Jwt-Assertion': 'token' } }), env, ctx);
  return { fake, rest, get };
}

type Body = {
  destination: string;
  date: string;
  destinations: string[];
  awaiting: number;
  rows: { invoiceAccessKey: string; status: { kind: string; action?: { kind: string; lines?: unknown[] } } }[];
};

// #72 Espelho do `DockActionDto` de `web/src/api/contract.ts`: o tsconfig da API não enxerga `web/`,
// então o formato é repetido aqui com os mesmos tipos do domínio. Este espelho guarda a API: se a
// doca mudar o fio, o typecheck e o teste abaixo quebram. Uma mudança só no `contract.ts` não é vista aqui.
type QuantityDto = { amount: number; unit: Unit };
type PartialLineDto = { sku: string; quantity: QuantityDto; disposition: PartialLine['disposition'] };
type DockActionDto = { kind: 'receber' | 'recusar' } | { kind: 'receber_parcial'; lines: PartialLineDto[] };

// Checagem de tipo, feita pelo `tsc` no `make check`: a ação que a doca serializa é exatamente o
// `DockActionDto`, nos dois sentidos da atribuição. Limite conhecido: um campo opcional a mais de um
// dos lados passa; a igualdade estrita não serve porque o domínio separa `receber` e `recusar` em dois
// membros da união, e o contrato junta os dois num só.
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[] : T[K] extends object ? Mutable<T[K]> : T[K] };
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const viewIsDto: Same<Mutable<DockActionView>, DockActionDto> = true;
void viewIsDto;

const UNITS: readonly unknown[] = ['UN', 'CX'] satisfies Unit[];
const DISPOSITIONS: readonly unknown[] = ['segurar', 'devolver'] satisfies PartialLine['disposition'][];

/** Checagem estrutural do JSON: o valor tem exatamente o formato de um `DockActionDto`. */
function isDockActionDto(value: unknown): value is DockActionDto {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === 'receber' || v.kind === 'recusar') return Object.keys(v).length === 1;
  if (v.kind !== 'receber_parcial' || !Array.isArray(v.lines) || Object.keys(v).length !== 2) return false;
  return v.lines.every((line: unknown) => {
    if (typeof line !== 'object' || line === null) return false;
    const l = line as Record<string, unknown>;
    const q = l.quantity as Record<string, unknown> | null;
    return (
      Object.keys(l).sort().join() === 'disposition,quantity,sku' &&
      typeof l.sku === 'string' &&
      DISPOSITIONS.includes(l.disposition) &&
      typeof q === 'object' &&
      q !== null &&
      Object.keys(q).sort().join() === 'amount,unit' &&
      typeof q.amount === 'number' &&
      UNITS.includes(q.unit)
    );
  });
}

describe('GET /api/doca (#72)', () => {
  it('#43/AC-2 a ação de um receber parcial no JSON tem o formato do DockActionDto da tela', async () => {
    const { rest, get } = setup();
    const [, b] = cd03;
    await wmsDockActionOutbox(rest).publish({
      invoiceAccessKey: b?.chave ?? '',
      action: DockAction.partial([{ sku: 'SKU-1025', quantity: Quantity.of(32, 'CX'), disposition: 'segurar' }]),
    });

    const body = (await (await get('/api/doca?destino=CD-03&data=2026-11-11')).json()) as Body;
    const action: unknown = body.rows[1]?.status.action;

    expect(isDockActionDto(action)).toBe(true);
    expect(isDockActionDto({ kind: 'receber_parcial', lines: [{ sku: 'SKU-1025', quantity: 32, unit: 'CX', disposition: 'segurar' }] })).toBe(false);
  });

  it('#43/AC-4 devolve as notas do dia do destino com a ação de cada uma, os destinos e as aguardando', async () => {
    const { rest, get } = setup();
    const [a, b] = cd03;
    await wmsDockActionOutbox(rest).publish({ invoiceAccessKey: a?.chave ?? '', action: DockAction.receive() });
    await wmsDockActionOutbox(rest).publish({
      invoiceAccessKey: b?.chave ?? '',
      action: DockAction.partial([
        { sku: 'SKU-1025', quantity: Quantity.of(32, 'CX'), disposition: 'segurar' },
        { sku: 'SKU-1024', quantity: Quantity.of(12, 'UN'), disposition: 'devolver' },
      ]),
    });

    const response = await get('/api/doca?destino=CD-03&data=2026-11-11');

    expect(response.status).toBe(200);
    const body = (await response.json()) as Body;
    expect(body.destination).toBe('CD-03');
    expect(body.date).toBe('2026-11-11');
    expect(body.destinations).toContain('CD-03');
    expect(body.rows.map((r) => r.invoiceAccessKey)).toEqual(cd03.map((n) => n.chave));
    expect(body.rows[0]?.status).toMatchObject({ kind: 'acao', action: { kind: 'receber' } });
    // #43/AC-2 os itens a segurar ou devolver chegam à doca.
    expect(body.rows[1]?.status.action).toEqual({
      kind: 'receber_parcial',
      lines: [
        { sku: 'SKU-1025', quantity: { amount: 32, unit: 'CX' }, disposition: 'segurar' },
        { sku: 'SKU-1024', quantity: { amount: 12, unit: 'UN' }, disposition: 'devolver' },
      ],
    });
    // #43/AC-3 a nota sem decisão aguarda; não diz receber.
    expect(body.rows[2]?.status).toEqual({ kind: 'aguardando_aprovacao', instrucao: 'Aguardando aprovação, não descarregue' });
    expect(body.awaiting).toBe(1);
  });

  it('#43/AC-4 sem destino, abre no primeiro destino do dia; sem data, usa hoje', async () => {
    const { get } = setup({ today: '2026-11-11' });

    const body = (await (await get('/api/doca')).json()) as Body;

    const destinations = [...new Set(kitNotes().filter((n) => n.data_emissao === '2026-11-11').map((n) => n.destino))].sort();
    expect(body.date).toBe('2026-11-11');
    expect(body.destination).toBe(destinations[0]);
    expect(body.destinations).toEqual(destinations);
  });

  it('dia sem notas responde 200 com a doca vazia', async () => {
    const { get } = setup();
    const response = await get('/api/doca?data=2026-12-25');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ destination: null, date: '2026-12-25', destinations: [], awaiting: 0, rows: [] });
  });

  for (const [name, query] of [
    ['data fora de AAAA-MM-DD', 'data=11/11/2026'],
    ['data que não existe', 'data=2026-02-30'],
    ['destino fora do formato', 'destino=cd-03%3Cscript%3E'],
    ['destino vazio', 'destino='],
  ] as const) {
    it(`#43/AC-4 ${name} responde 400 sem ecoar o valor`, async () => {
      const { fake, get } = setup();
      const response = await get(`/api/doca?${query}`);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: 'invalid_query' });
      expect(text).not.toContain('script');
      expect(text).not.toContain('11/11');
      expect(fake.requests).toHaveLength(0);
    });
  }

  it('#43/AC-4 sem credenciais do Supabase responde 503', async () => {
    const { get } = setup();
    const response = await get('/api/doca?destino=CD-03', ACCESS);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'supabase_not_configured' });
  });

  it('falha do Supabase responde 502 sem detalhe e registra só operação, tabela e status', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = createWorker({
      verifier,
      dock: {
        supabase: () => new SupabaseRest({ url: 'https://supabase.test', secretKey: 'sb_teste', fetch: async () => new Response('boom segredo', { status: 500 }) }),
      },
    });
    const response = await worker.fetch(
      new Request('https://worker.test/api/doca?data=2026-11-11', { headers: { 'Cf-Access-Jwt-Assertion': 'token' } }),
      { ...ACCESS, ...SUPABASE },
      ctx,
    );
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'supabase_unavailable' });
    expect(text).not.toContain('segredo');
    expect(log).toHaveBeenCalledWith('doca: leitura do Supabase falhou', expect.objectContaining({ operation: 'select', status: 500 }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('segredo');
    log.mockRestore();
  });

  it('sem token responde 401 antes de ler o Supabase', async () => {
    const { fake } = setup();
    const worker = createWorker({ verifier });
    const response = await worker.fetch(new Request('https://worker.test/api/doca'), { ...ACCESS, ...SUPABASE }, ctx);
    expect(response.status).toBe(401);
    expect(fake.requests).toHaveLength(0);
  });

  it('método que não é GET responde 405', async () => {
    const { get } = setup();
    const response = await get('/api/doca', undefined, 'POST');
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  it('/me continua igual', async () => {
    const { get } = setup();
    const response = await get('/me');
    expect(await response.json()).toEqual({ email: 'doca@jachegou.test' });
  });
});
