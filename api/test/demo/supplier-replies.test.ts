import { describe, expect, it } from 'vitest';
import {
  SUPPLIER_REPLIES_COST,
  drawReply,
  planSupplierReplies,
  supplierRepliesStep,
  type InboxMessageRow,
  type PlannedReply,
  type SentRequest,
} from '../../src/demo/supplier-replies.js';

const ROUND_MS = 15 * 60 * 1000;
const T0 = new Date('2026-11-20T10:00:00.000Z');
const afterRounds = (n: number): Date => new Date(T0.getTime() + n * ROUND_MS);
const request = (requestId: number): SentRequest => ({ requestId, recipient: `vendas${requestId}@fornecedor.example`, sentAt: T0 });
const requests = (n: number): SentRequest[] => Array.from({ length: n }, (_, i) => request(i + 1));
const plan = (reqs: SentRequest[], rounds: number, seed = 's1') =>
  planSupplierReplies(reqs, { clock: () => afterRounds(rounds), seed, roundMs: ROUND_MS });

describe('#363/AC-2: a resposta chega entre 2 e 10 rodadas depois do envio, ou nunca', () => {
  it('#363/AC-2: o atraso sorteado fica entre 2 e 10 rodadas', () => {
    const delays = new Set<number>();
    for (let id = 1; id <= 600; id += 1) {
      const draw = drawReply('s1', id);
      if (draw.outcome !== 'never_replies') delays.add(draw.delayRounds);
    }
    expect(Math.min(...delays)).toBe(2);
    expect(Math.max(...delays)).toBe(10);
  });

  it('#363/AC-2: antes do atraso não há resposta; a partir dele há uma, na caixa de entrada mock', () => {
    const req = requests(200).find((r) => drawReply('s1', r.requestId).outcome !== 'never_replies');
    if (!req) throw new Error('amostra sem resposta');
    const n = drawReply('s1', req.requestId).delayRounds;
    expect(plan([req], n - 1)).toEqual([]);
    const [reply] = plan([req], n);
    expect(reply?.origin).toBe('demo');
    expect(reply?.row).toMatchObject({
      request_id: req.requestId,
      source_message_id: `demo-resposta-${req.requestId}`,
      from_address: req.recipient,
      attachments_meta: [],
      received_at: afterRounds(n).toISOString(),
    });
    expect(reply?.row.body.length).toBeGreaterThan(0);
  });

  it('#363/AC-2: quem nunca responde não gera nada, por mais rodadas que passem', () => {
    const never = requests(300).filter((r) => drawReply('s1', r.requestId).outcome === 'never_replies');
    expect(never.length).toBeGreaterThan(0);
    expect(plan(never, 1000)).toEqual([]);
  });
});

describe('#363/AC-3: sobre uma amostra saem os cinco desfechos e uma pequena parte com ordem escondida', () => {
  const sample = (): PlannedReply[] => plan(requests(1000), 50);

  it('#363/AC-3: os quatro desfechos que respondem aparecem na amostra, e o "nunca responde" fica sem linha', () => {
    const outcomes = new Set(sample().map((r) => r.outcome));
    expect([...outcomes].sort()).toEqual(['fulfilled', 'needs_information', 'partially_fulfilled', 'refused']);
    const never = requests(1000).filter((r) => drawReply('s1', r.requestId).outcome === 'never_replies');
    expect(never.length).toBeGreaterThan(0);
    expect(sample()).toHaveLength(1000 - never.length);
  });

  it('#363/AC-3: uma pequena parte das respostas traz a ordem escondida no texto, em qualquer desfecho', () => {
    const replies = sample();
    const hidden = replies.filter((r) => r.hiddenOrder);
    const share = hidden.length / replies.length;
    expect(share).toBeGreaterThan(0.03);
    expect(share).toBeLessThan(0.2);
    expect(new Set(hidden.map((r) => r.outcome)).size).toBeGreaterThan(1);
    expect(hidden.every((r) => /libere o pagamento/i.test(r.row.body))).toBe(true);
    expect(replies.filter((r) => !r.hiddenOrder).some((r) => /libere o pagamento/i.test(r.row.body))).toBe(false);
  });

  it('#363/AC-3: "atendeu" pode citar um documento de até duas palavras e nenhum outro número aparece', () => {
    const replies = sample();
    const docs = replies.filter((r) => /NF-D \d+/.test(r.row.body));
    expect(docs.length).toBeGreaterThan(0);
    for (const r of replies) {
      const withoutDoc = r.row.body.replace(/NF-D \d+/g, '');
      expect(withoutDoc).not.toMatch(/\d/);
    }
  });
});

describe('#363/AC-4: o passo das respostas grava em lote, dentro do custo, de forma determinística', () => {
  const world = (pending: SentRequest[]) => {
    const calls = { reads: 0, writes: [] as InboxMessageRow[][] };
    const source = { listPending: async () => { calls.reads += 1; return pending; } };
    const sink = { writeBatch: async (rows: InboxMessageRow[]) => { calls.writes.push(rows); } };
    return { calls, source, sink };
  };

  it('#363/AC-4: o custo declarado é de 2 subrequests e o passo tem a forma do passo de rodada', () => {
    const step = supplierRepliesStep({ ...world([]), clock: () => T0, seed: 's', roundMs: ROUND_MS });
    expect(SUPPLIER_REPLIES_COST).toBe(2);
    expect(step.maxSubrequests).toBe(SUPPLIER_REPLIES_COST);
  });

  it('#363/AC-4: várias respostas prontas saem numa leitura e uma gravação em lote', async () => {
    const w = world(requests(30));
    await supplierRepliesStep({ ...w, clock: () => afterRounds(50), seed: 's', roundMs: ROUND_MS }).run();
    expect(w.calls.reads).toBe(1);
    expect(w.calls.writes).toHaveLength(1);
    expect(w.calls.writes[0]?.length).toBeGreaterThan(1);
    expect(w.calls.reads + w.calls.writes.length).toBeLessThanOrEqual(SUPPLIER_REPLIES_COST);
  });

  it('#363/AC-4: sem resposta pronta, a gravação é pulada', async () => {
    const w = world(requests(5));
    await supplierRepliesStep({ ...w, clock: () => T0, seed: 's', roundMs: ROUND_MS }).run();
    expect(w.calls.writes).toEqual([]);
  });

  it('#363/AC-4: o lote respeita o limite configurado', async () => {
    const w = world(requests(100));
    await supplierRepliesStep({ ...w, clock: () => afterRounds(50), seed: 's', roundMs: ROUND_MS, batchLimit: 4 }).run();
    expect(w.calls.writes[0]).toHaveLength(4);
  });

  it('#363/AC-4: mesma semente, relógio e entrada dão a mesma saída; outra semente muda os sorteios', () => {
    expect(plan(requests(50), 50, 's1')).toEqual(plan(requests(50), 50, 's1'));
    expect(plan(requests(50), 50, 's1')).not.toEqual(plan(requests(50), 50, 's2'));
  });
});
