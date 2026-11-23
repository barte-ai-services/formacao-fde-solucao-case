// #363 Os adaptadores das portas da demonstração: cada porta é uma requisição, só notas demo são lidas e toda linha gravada leva origin demo.
import { describe, expect, it } from 'vitest';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { supabaseDockCountPorts, supabaseSupplierReplyPorts } from '../../src/demo/supabase-demo-ports.js';

type Call = { method: string; path: string; body: unknown };

/** #363 Um fetch falso que anota a requisição e devolve o que a rota combinou. */
function stub(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(input).pathname.replace('/rest/v1/', '');
    calls.push({ method: init.method ?? 'GET', path, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(answers[path] ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, rest: new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch }) };
}

const ACTION = {
  actionId: 'dock-1', channel: 'dock', invoiceAccessKey: 'K1', publishedAt: '2026-11-23T10:00:00+00:00', supplierId: 'F08', store: 'LJ-001',
  purchaseOrderId: null, classification: 'E3', items: [{ supplierCode: 'F08-001', description: 'Arroz', quantity: 4, unit: 'UN' }],
};

describe('#363 a contagem da doca: uma rpc de leitura e uma de gravação', () => {
  it('lê as ações pendentes numa requisição só e devolve datas e itens no formato do módulo', async () => {
    const w = stub({ 'rpc/demo_dock_count_pending': [ACTION] });
    const [action] = await supabaseDockCountPorts(w.rest).source.listPending();
    expect(w.calls.map((c) => c.path)).toEqual(['rpc/demo_dock_count_pending']);
    expect(action).toMatchObject({ actionId: 'dock-1', classification: 'E3', items: [{ supplierCode: 'F08-001', quantity: 4 }] });
    expect(action?.publishedAt).toEqual(new Date('2026-11-23T10:00:00Z'));
  });

  it('grava o lote inteiro numa requisição só, com as duas tabelas do kit', async () => {
    const w = stub({});
    await supabaseDockCountPorts(w.rest).sink.writeBatch({ receipts: [{ recebimento_id: 'RC-DOCA-K1', origin: 'demo' } as never], items: [{ recebimento_id: 'RC-DOCA-K1' } as never] });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ method: 'POST', path: 'rpc/demo_insert_dock_counts' });
    expect(Object.keys((w.calls[0]?.body as { p_batch: object }).p_batch)).toEqual(['kit_recebimentos', 'kit_recebimento_itens']);
  });

  it('uma linha fora do formato falha na leitura, sem devolver dado', async () => {
    const w = stub({ 'rpc/demo_dock_count_pending': [{ ...ACTION, items: 'x' }] });
    await expect(supabaseDockCountPorts(w.rest).source.listPending()).rejects.toThrow(/fora do formato/);
  });
});

describe('#363 as respostas do fornecedor: uma rpc de leitura e um insert em lote', () => {
  it('lê os pedidos enviados sem resposta numa requisição só', async () => {
    const w = stub({ 'rpc/demo_supplier_replies_pending': [{ requestId: 7, recipient: 'a@f.test', sentAt: '2026-11-23T10:00:00+00:00' }] });
    const [request] = await supabaseSupplierReplyPorts(w.rest).source.listPending();
    expect(w.calls.map((c) => c.path)).toEqual(['rpc/demo_supplier_replies_pending']);
    expect(request).toEqual({ requestId: 7, recipient: 'a@f.test', sentAt: new Date('2026-11-23T10:00:00Z') });
  });

  it('grava as respostas numa requisição só, todas origin demo, ignorando a repetida pelo source_message_id', async () => {
    const w = stub({});
    const row = { request_id: 7, source_message_id: 'demo-resposta-7', from_address: 'a@f.test', body: 'ok', attachments_meta: [], received_at: '2026-11-23T10:05:00Z' } as const;
    await supabaseSupplierReplyPorts(w.rest).sink.writeBatch([row, { ...row, request_id: 8, source_message_id: 'demo-resposta-8' }]);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]?.path).toBe('inbox_supplier_messages');
    expect((w.calls[0]?.body as { origin: string }[]).map((r) => r.origin)).toEqual(['demo', 'demo']);
  });
});
