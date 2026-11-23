import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DOCK_COUNT_COST,
  dockCountStep,
  dockCountDelay,
  planDockCount,
  type DockCountBatch,
  type PendingDockAction,
} from '../../src/demo/dock-count.js';
import { checkFaltaFisica } from '../../src/domain/checks/e1-falta-fisica.js';
import { checkQuantidadeMenor } from '../../src/domain/checks/e3-quantidade-menor.js';
import { Invoice, Money, Quantity, type Receipt } from '../../src/domain/index.js';
import { emptyContext } from '../domain/fixtures.js';

const ROUND_MS = 15 * 60 * 1000;
const T0 = new Date('2026-11-20T10:00:00.000Z');
const afterRounds = (n: number): Date => new Date(T0.getTime() + n * ROUND_MS);
const KEY = '35261100000000000000550010000099991000099999';

const action = (overrides: Partial<PendingDockAction> = {}): PendingDockAction => ({
  actionId: 'a-1',
  channel: 'dock',
  invoiceAccessKey: KEY,
  publishedAt: T0,
  supplierId: 'F08',
  store: 'LJ-001',
  purchaseOrderId: 'OC-1',
  classification: null,
  items: [
    { supplierCode: 'F08-001', description: 'Óleo de soja 900 ml', quantity: 100, unit: 'UN' },
    { supplierCode: 'F08-002', description: 'Arroz 5 kg', quantity: 40, unit: 'UN' },
    { supplierCode: 'F08-003', description: 'Feijão 1 kg', quantity: 1, unit: 'UN' },
  ],
  ...overrides,
});

const plan = (a: PendingDockAction, now: Date, seed = 's1') => planDockCount([a], { clock: () => now, seed, roundMs: ROUND_MS });
const firstReadyRound = (a: PendingDockAction, seed = 's1'): number => dockCountDelay(seed, a.invoiceAccessKey);

describe('#363/AC-1: a contagem da doca chega entre 2 e 5 rodadas depois da publicação', () => {
  it('#363/AC-1: o atraso sorteado fica entre 2 e 5 rodadas, para qualquer nota', () => {
    const delays = new Set<number>();
    for (let i = 0; i < 200; i += 1) delays.add(dockCountDelay('s1', `chave-${i}`));
    expect([...delays].sort()).toEqual([2, 3, 4, 5]);
  });

  it('#363/AC-1: antes do atraso sorteado não gera contagem; a partir dele gera', () => {
    const a = action();
    const n = firstReadyRound(a);
    expect(plan(a, afterRounds(n - 1))).toEqual([]);
    expect(plan(a, afterRounds(n))).toHaveLength(1);
    expect(plan(a, afterRounds(n + 3))).toHaveLength(1);
  });

  it('#363/AC-1: o recebimento é RC-DOCA-<chave>, ligado à nota, no canal da doca, com data do relógio e origem demo', () => {
    const a = action();
    const [row] = plan(a, afterRounds(firstReadyRound(a)));
    expect(row?.receipt).toMatchObject({
      recebimento_id: `RC-DOCA-${KEY}`, // ADR-001
      nota_chave: KEY, // ADR-001
      ordem_id: 'OC-1', // ADR-001
      fornecedor_id: 'F08', // ADR-001
      destino: 'LJ-001', // ADR-001
      canal: 'doca_cd', // ADR-001
      data: '2026-11-20', // ADR-001
      origin: 'demo',
    });
    expect(row?.receipt.observacao).not.toBe(''); // ADR-001
  });

  it('#363/AC-1: duas ações da mesma nota (doca e loja) geram um único recebimento, o da publicação mais antiga', () => {
    const later = action({ actionId: 'a-1', channel: 'dock', publishedAt: afterRounds(1) });
    const earlier = action({ actionId: 'a-2', channel: 'store', publishedAt: T0 });
    const rows = planDockCount([later, earlier], { clock: () => afterRounds(20), seed: 's1', roundMs: ROUND_MS });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.receipt.canal).toBe('app_loja'); // ADR-001
    const ids = rows.map((r) => r.receipt.recebimento_id); // ADR-001
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('#363/AC-1: no empate de publicação, vence o menor actionId, qualquer que seja a ordem da entrada', () => {
    const a = action({ actionId: 'a-1', channel: 'dock' });
    const b = action({ actionId: 'a-2', channel: 'store' });
    const options = { clock: () => afterRounds(20), seed: 's1', roundMs: ROUND_MS };
    expect(planDockCount([b, a], options).map((r) => r.receipt.canal)).toEqual(['doca_cd']); // ADR-001
    expect(planDockCount([a, b], options).map((r) => r.receipt.canal)).toEqual(['doca_cd']); // ADR-001
  });

  it('#363/AC-1: ação do canal loja gera o recebimento no canal app_loja', () => {
    const a = action({ channel: 'store' });
    const [row] = plan(a, afterRounds(firstReadyRound(a)));
    expect(row?.receipt.canal).toBe('app_loja'); // ADR-001
  });

  it('#363/AC-1: sem exceção (ou outra classificação) conta exatamente o que a nota traz', () => {
    for (const classification of [null, 'E2', 'E4', 'E8']) {
      const a = action({ classification });
      const [row] = plan(a, afterRounds(5));
      expect(row?.items.map((i) => [i.codigo_fornecedor, i.quantidade, i.unidade])).toEqual([ // ADR-001
        ['F08-001', 100, 'UN'],
        ['F08-002', 40, 'UN'],
        ['F08-003', 1, 'UN'],
      ]);
      expect(row?.items.every((i) => i.recebimento_id === `RC-DOCA-${KEY}`)).toBe(true); // ADR-001
    }
  });

  it('#363/AC-1: E1 (falta física) omite um item da nota, contado zero', () => {
    const [row] = plan(action({ classification: 'E1' }), afterRounds(5));
    expect(row?.items).toHaveLength(2);
  });

  it('#363/AC-1: E3 (quantidade menor) conta menos num item com mais de uma unidade, mas acima de zero', () => {
    for (let i = 0; i < 30; i += 1) {
      const [row] = plan(action({ classification: 'E3', actionId: `a-${i}`, invoiceAccessKey: `K-${i}` }), afterRounds(5), `seed-${i}`);
      const bySupplierCode = new Map(row?.items.map((it) => [it.codigo_fornecedor, it.quantidade])); // ADR-001
      expect(bySupplierCode.size).toBe(3);
      const lower = [...bySupplierCode].filter(([code, q]) => q < (code === 'F08-001' ? 100 : code === 'F08-002' ? 40 : 1));
      expect(lower).toHaveLength(1);
      expect(lower[0]?.[1]).toBeGreaterThan(0);
    }
  });

  it('#363/AC-1: E3 sem item de mais de uma unidade não tem como contar menos: conta o que a nota traz', () => {
    const a = action({ classification: 'E3', items: [{ supplierCode: 'F08-003', description: 'Feijão 1 kg', quantity: 1, unit: 'UN' }] });
    const [row] = plan(a, afterRounds(5));
    expect(row?.items.map((i) => i.quantidade)).toEqual([1]); // ADR-001
  });

  it('#363/AC-1: passada pelo domínio real, a contagem de E1 vira falta física e a de E3 vira quantidade menor, e as outras nenhuma', () => {
    const invoice = Invoice.receive({
      accessKey: KEY,
      number: '9999',
      series: '1',
      supplierId: 'F08',
      store: 'LJ-001',
      issuedOn: '2026-11-10',
      purchaseOrderRef: 'OC-1',
      entryChannel: 'SEFAZ',
      items: [
        { supplierCode: 'F08-001', sku: 'SKU-1', description: 'Óleo de soja 900 ml', quantity: Quantity.of(100, 'UN'), unitPrice: Money.ofCents(1000), total: Money.ofCents(100_000) },
      ],
      total: Money.ofCents(100_000),
    });
    const single = (classification: string | null) =>
      action({ classification, items: [{ supplierCode: 'F08-001', description: 'Óleo de soja 900 ml', quantity: 100, unit: 'UN' }] });
    const asReceipt = (classification: string | null): Receipt => {
      const [row] = plan(single(classification), afterRounds(5));
      if (!row) throw new Error('sem contagem');
      return {
        id: row.receipt.recebimento_id, // ADR-001
        invoiceAccessKey: row.receipt.nota_chave, // ADR-001
        purchaseOrderId: row.receipt.ordem_id, // ADR-001
        supplierId: row.receipt.fornecedor_id, // ADR-001
        store: row.receipt.destino, // ADR-001
        receivedOn: row.receipt.data, // ADR-001
        note: row.receipt.observacao, // ADR-001
        items: row.items.map((i) => ({ supplierCode: i.codigo_fornecedor, description: i.descricao, quantity: Quantity.of(i.quantidade, i.unidade === 'CX' ? 'CX' : 'UN') })), // ADR-001
      };
    };
    const ctx = (c: string | null) => emptyContext({ receipts: [asReceipt(c)] });
    expect(checkFaltaFisica(invoice, ctx('E1')).map((d) => d.classification)).toEqual(['E1']);
    expect(checkQuantidadeMenor(invoice, ctx('E1'))).toEqual([]);
    expect(checkQuantidadeMenor(invoice, ctx('E3')).map((d) => d.classification)).toEqual(['E3']);
    expect(checkFaltaFisica(invoice, ctx('E3'))).toEqual([]);
    expect(checkFaltaFisica(invoice, ctx(null))).toEqual([]);
    expect(checkQuantidadeMenor(invoice, ctx(null))).toEqual([]);
  });
});

describe('#363/AC-4: o passo da contagem grava em lote, dentro do custo, de forma determinística', () => {
  const world = (pending: PendingDockAction[]) => {
    const calls = { reads: 0, writes: [] as DockCountBatch[] };
    const source = { listPending: async () => { calls.reads += 1; return pending; } };
    const sink = { writeBatch: async (batch: DockCountBatch) => { calls.writes.push(batch); } };
    return { calls, source, sink };
  };
  const pendings = (n: number) => Array.from({ length: n }, (_, i) => action({ actionId: `a-${i}`, invoiceAccessKey: `K-${i}` }));

  it('#363/AC-4: o custo declarado é de 2 subrequests (uma leitura e um lote) e o passo tem a forma do passo de rodada', () => {
    const w = world([]);
    const step = dockCountStep({ ...w, clock: () => T0, seed: 's', roundMs: ROUND_MS });
    expect(DOCK_COUNT_COST).toBe(2);
    expect(step.maxSubrequests).toBe(DOCK_COUNT_COST);
    expect(typeof step.name).toBe('string');
  });

  it('#363/AC-4: com várias ações prontas, uma leitura e uma única gravação em lote', async () => {
    const w = world(pendings(12));
    await dockCountStep({ ...w, clock: () => afterRounds(5), seed: 's', roundMs: ROUND_MS }).run();
    expect(w.calls.reads).toBe(1);
    expect(w.calls.writes).toHaveLength(1);
    expect(w.calls.writes[0]?.receipts).toHaveLength(12);
    expect(w.calls.reads + w.calls.writes.length).toBeLessThanOrEqual(DOCK_COUNT_COST);
  });

  it('#363/AC-4: sem nada pronto, só a leitura: a gravação é pulada', async () => {
    const w = world(pendings(3));
    await dockCountStep({ ...w, clock: () => T0, seed: 's', roundMs: ROUND_MS }).run();
    expect(w.calls.reads).toBe(1);
    expect(w.calls.writes).toEqual([]);
  });

  it('#363/AC-4: o lote respeita o limite configurado', async () => {
    const w = world(pendings(12));
    await dockCountStep({ ...w, clock: () => afterRounds(5), seed: 's', roundMs: ROUND_MS, batchLimit: 5 }).run();
    expect(w.calls.writes[0]?.receipts).toHaveLength(5);
  });

  it('#363/AC-4: a mesma semente, relógio e entrada dão a mesma saída; outra semente muda os sorteios', () => {
    const input = pendings(40).map((a, i) => ({ ...a, classification: i % 2 === 0 ? 'E3' : 'E1' }));
    const run = (seed: string) => planDockCount(input, { clock: () => afterRounds(3), seed, roundMs: ROUND_MS });
    expect(run('s1')).toEqual(run('s1'));
    expect(run('s1')).not.toEqual(run('s2'));
  });

  it('#363/AC-4: o módulo não usa Date.now nem Math.random', () => {
    for (const file of ['dock-count', 'supplier-replies', 'seeded-draw', 'demo-step']) {
      const text = readFileSync(new URL(`../../src/demo/${file}.ts`, import.meta.url), 'utf8');
      expect(text).not.toMatch(/Date\.now|Math\.random|new Date\(\s*\)/);
    }
  });
});
