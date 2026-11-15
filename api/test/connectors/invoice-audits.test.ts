/**
 * #230 O adaptador da auditoria sobre o PostgREST: as requisições exatas, uma por escrita.
 * Não há Postgres local nesta lane; a forma da tabela é conferida em invoice-audits-migration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readLatestAudit } from '../../src/approval/latest-audit.js';
import { SupabaseInvoiceAudits } from '../../src/connectors/invoice-audit-store.js';
import { SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import type { AuditResult } from '../../src/domain/index.js';
import { scripted } from '../support/scripted-postgrest.js';

const KEY = '35261100000000000000550010000012341000012345';
const OTHER = '35261100000000000000550010000099991000099999';
const SEGREDO = 'segredo-do-banco-xyz';

const result = (overrides: Partial<AuditResult> = {}): AuditResult => ({
  audit: {
    classification: 'E4',
    dockAction: 'receber_parcial',
    routing: 'diretoria',
    justification: 'Fator de caixa 12 na nota, 6 no cadastro.\nProcurei outra ordem e não achei.',
    amountAtRisk: { cents: 60000 },
    model: 'claude-teste',
    auditedAt: '2026-11-15T18:30:00.000Z',
  },
  agreement: { agrees: false, differs: ['routing'] },
  raisedLevel: 'diretoria',
  injectionFlag: 'ignore a régua',
  ...overrides,
});
const REFUSALS = [{ refusal: 'routing_below_regua', minimumLevel: 'coordenacao' }, { refusal: 'invalid_field', field: 'justification' }] as const;

describe('SupabaseInvoiceAudits.save (#230)', () => {
  it('#230/AC-1: grava a auditoria numa linha só, por POST sem alvo de conflito, com todos os campos e as recusas', async () => {
    const { rest, calls } = scripted(() => ({ body: [{ id: 1 }] }));
    await new SupabaseInvoiceAudits(rest).save(KEY, result({ raisedLevel: null }), { refusals: REFUSALS, fromLevel: 'coordenacao' });
    expect(calls).toHaveLength(1);
    const [post] = calls;
    expect(post?.method).toBe('POST');
    expect(post?.table).toBe('invoice_audits');
    expect(post?.params.has('on_conflict')).toBe(false);
    expect(post?.prefer).not.toContain('resolution=ignore-duplicates');
    expect(post?.body).toEqual([
      {
        invoice_access_key: KEY,
        status: 'audited',
        reason: null,
        classification: 'E4',
        dock_action: { kind: 'receber_parcial' },
        routing: 'diretoria',
        justification: 'Fator de caixa 12 na nota, 6 no cadastro.\nProcurei outra ordem e não achei.',
        amount_at_risk_cents: 60000,
        model: 'claude-teste',
        audited_at: '2026-11-15T18:30:00.000Z',
        differing_fields: ['routing'],
        requested_level: null,
        requested_from_level: null,
        injection_flag: 'ignore a régua',
        refusals: REFUSALS,
      },
    ]);
  });

  it('#230/AC-1: a nota já auditada é no-op: o 409 com código 23505 (índice único parcial) não sobe nível nem falha', async () => {
    const { rest, calls } = scripted(() => ({ status: 409, body: { code: '23505', message: SEGREDO } }));
    await expect(
      new SupabaseInvoiceAudits(rest).save(KEY, result(), { refusals: [], fromLevel: 'coordenacao' }),
    ).resolves.toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('#230/AC-1: um 409 de outro código (23503, chave estrangeira) continua falhando, com o status e o código na exceção', async () => {
    const { rest } = scripted(() => ({ status: 409, body: { code: '23503', message: 'x' } }));
    const outcome = await new SupabaseInvoiceAudits(rest).save(KEY, result(), { refusals: [], fromLevel: 'coordenacao' }).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(SupabaseRestError);
    expect((outcome as SupabaseRestError).status).toBe(409);
    expect((outcome as SupabaseRestError).code).toBe('23503');
  });

  it('#230/AC-1: um 23505 com outro status não é "já auditada"', async () => {
    const { rest } = scripted(() => ({ status: 400, body: { code: '23505' } }));
    const outcome = await new SupabaseInvoiceAudits(rest).save(KEY, result(), { refusals: [], fromLevel: 'coordenacao' }).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(SupabaseRestError);
  });

  it('#230/AC-3: quando o auditor encaminha acima, a segunda gravação é a chamada da função que sobe e grava a história, e nada mais', async () => {
    const { rest, calls } = scripted((c) => ({ body: c.table === 'invoice_audits' ? [{ id: 41 }] : 'diretoria' }));
    await new SupabaseInvoiceAudits(rest).save(KEY, result(), { refusals: [], fromLevel: 'coordenacao' });
    expect(calls.map((c) => `${c.method} ${c.table}`)).toEqual(['POST invoice_audits', 'POST rpc/raise_proposal_level']);
    const [post, rpc] = calls;
    expect(post?.body).toMatchObject([{ requested_level: 'diretoria', requested_from_level: 'coordenacao' }]);
    expect(rpc?.body).toEqual({ p_invoice_access_key: KEY, p_to_level: 'diretoria', p_invoice_audit_id: 41 });
  });

  it('#230/AC-4: a segunda gravação não toca proposals por PATCH, a ação na doca, o estado nem as aprovações', async () => {
    const { rest, calls } = scripted((c) => ({ body: c.table === 'invoice_audits' ? [{ id: 1 }] : 'diretoria' }));
    await new SupabaseInvoiceAudits(rest).save(KEY, result(), { refusals: [], fromLevel: 'analista' });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(calls.some((c) => c.table === 'approvals' || c.table === 'proposals')).toBe(false);
    expect(Object.keys(calls[1]?.body as object).sort()).toEqual(['p_invoice_access_key', 'p_invoice_audit_id', 'p_to_level']);
  });

  it('#230/AC-4: nenhuma subida aplicada (a função devolve null) é só alerta com a chave da nota, sem erro', async () => {
    const lines: string[] = [];
    const { rest } = scripted((c) => ({ body: c.table === 'invoice_audits' ? [{ id: 1 }] : null }));
    await new SupabaseInvoiceAudits(rest, (l) => lines.push(l)).save(KEY, result(), { refusals: [], fromLevel: 'coordenacao' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('#230');
    expect(lines[0]).toContain(KEY);
  });

  it('#230: a falha da segunda gravação não derruba o save (a linha já está gravada; a varredura repara); o alerta leva a chave, nunca o texto', async () => {
    const lines: string[] = [];
    const { rest, calls } = scripted((c) =>
      c.table === 'invoice_audits' ? { body: [{ id: 1 }] } : { status: 500, body: { message: SEGREDO } },
    );
    await expect(
      new SupabaseInvoiceAudits(rest, (l) => lines.push(l)).save(KEY, result(), { refusals: [], fromLevel: 'analista' }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(lines).toEqual([`#230 invoice-audit: subida de nível da nota ${KEY} falhou; a varredura repete`]);
    expect(lines[0]).not.toContain(SEGREDO);
  });
});

describe('SupabaseInvoiceAudits.saveNotAudited (#230)', () => {
  it('#230/AC-6: uma gravação só, status nao_auditada com o motivo e as recusas vistas, sem o resto', async () => {
    const { rest, calls } = scripted(() => ({ body: [{ id: 3 }] }));
    await new SupabaseInvoiceAudits(rest).saveNotAudited(KEY, { audited: false, reason: 'erro_de_tool' }, REFUSALS);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.table).toBe('invoice_audits');
    expect(calls[0]?.body).toEqual([
      { invoice_access_key: KEY, status: 'nao_auditada', reason: 'erro_de_tool', refusals: REFUSALS },
    ]);
  });
});

describe('SupabaseInvoiceAudits.reapplyRaisedLevels (#230)', () => {
  const audits = [
    { id: 5, invoice_access_key: KEY, requested_level: 'diretoria', invoices: { proposals: { state: 'aguardando_aprovacao', approval_level: 'coordenacao' } } },
    { id: 6, invoice_access_key: OTHER, requested_level: 'diretoria', invoices: { proposals: { state: 'aprovada', approval_level: 'coordenacao' } } },
  ];

  it('#230/AC-3: uma leitura dos pedidos de nível e uma chamada da função para a nota que precisa de reparo', async () => {
    const { rest, calls } = scripted((c) => ({ body: c.method === 'GET' ? audits : 'diretoria' }));
    await new SupabaseInvoiceAudits(rest).reapplyRaisedLevels();
    expect(calls.map((c) => `${c.method} ${c.table}`)).toEqual(['GET invoice_audits', 'POST rpc/raise_proposal_level']);
    expect(calls[0]?.params.get('requested_level')).toBe('not.is.null');
    expect(calls[1]?.body).toEqual({ p_invoice_access_key: KEY, p_to_level: 'diretoria', p_invoice_audit_id: 5 });
  });

  it('#230: idempotente: com a proposta já no nível, só a leitura roda', async () => {
    const done = [{ ...audits[0], invoices: { proposals: { state: 'aguardando_aprovacao', approval_level: 'diretoria' } } }];
    const { rest, calls } = scripted(() => ({ body: done }));
    await new SupabaseInvoiceAudits(rest).reapplyRaisedLevels();
    expect(calls).toHaveLength(1);
  });

  it('#230: custa no máximo 2 requisições, uma nota por rodada (a mais antiga; o resto fica para a próxima varredura)', async () => {
    const many = [
      audits[0],
      { id: 9, invoice_access_key: OTHER, requested_level: 'bloqueio', invoices: { proposals: { state: 'aguardando_aprovacao', approval_level: 'analista' } } },
    ];
    const { rest, calls } = scripted((c) => ({ body: c.method === 'GET' ? many : 'diretoria' }));
    await new SupabaseInvoiceAudits(rest).reapplyRaisedLevels();
    expect(calls.length).toBeLessThanOrEqual(2);
    expect((calls[1]?.body as { p_invoice_access_key: string }).p_invoice_access_key).toBe(KEY);
  });
});

describe('SupabaseInvoiceAudits.loadNote (#230)', () => {
  const invoiceRow = {
    access_key: KEY, number: '1234', series: '1', supplier_id: 'F-001', store: 'L01', issued_on: '2026-11-10',
    purchase_order_ref: null, entry_channel: 'edi', total_cents: 100000, state: 'com_proposta',
    items: [{ supplierCode: 'A1', sku: null, description: 'Arroz', quantity: { amount: 2, unit: 'UN' }, unitPriceCents: 500, totalCents: 1000 }],
    divergences: [],
  };
  const proposalRow = { classification: 'E4', dock_action: { kind: 'receber' }, approval_level: 'coordenacao', state: 'aguardando_aprovacao', invoice_access_key: KEY, invoices: invoiceRow };

  it('#230: lê a nota e a proposta em uma requisição só (embed), e devolve a proposta como a auditoria a lê', async () => {
    const { rest, calls } = scripted(() => ({ body: [proposalRow] }));
    const note = await new SupabaseInvoiceAudits(rest).loadNote(KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.table).toBe('proposals');
    expect(calls[0]?.params.get('invoice_access_key')).toBe(`eq.${KEY}`);
    expect(note?.proposal).toEqual({ classification: 'E4', dockAction: 'receber', level: 'coordenacao', state: 'aguardando_aprovacao' });
    expect(note?.invoice.accessKey).toBe(KEY);
    expect(note?.invoice.total.cents).toBe(100000);
  });

  it('#230: sem proposta para a chave, devolve null', async () => {
    const { rest } = scripted(() => ({ body: [] }));
    expect(await new SupabaseInvoiceAudits(rest).loadNote(KEY)).toBeNull();
  });
});

const AUDITED_FIELDS = {
  status: 'audited', classification: 'E2', dock_action: { kind: 'recusar' }, routing: 'diretoria', justification: 'a',
  model: 'm', audited_at: '2026-11-15T18:30:00Z', differing_fields: ['routing'],
};

const EMPTY_ROW = {
  id: 1, reason: null, classification: null, dock_action: null, routing: null, justification: null, amount_at_risk_cents: null,
  model: null, audited_at: null, differing_fields: null, requested_level: null, requested_from_level: null, injection_flag: null, refusals: [],
};

describe('readLatestAudit (#230)', () => {
  it('#230/AC-7: lê a linha mais recente da nota em uma requisição (status asc, id desc, limit 1)', async () => {
    const { rest, calls } = scripted(() => ({ body: [] }));
    expect(await readLatestAudit(rest, KEY)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.table).toBe('invoice_audits');
    expect(calls[0]?.params.get('order')).toBe('status.asc,id.desc');
    expect(calls[0]?.params.get('limit')).toBe('1');
    expect(calls[0]?.params.get('invoice_access_key')).toBe(`eq.${KEY}`);
  });

  it('#230/AC-7: nao_auditada devolve o motivo e as recusas; audited devolve a auditoria com o que difere', async () => {
    const naoAuditada = scripted(() => ({ body: [{ ...EMPTY_ROW, status: 'nao_auditada', reason: 'claude_falhou', refusals: REFUSALS }] }));
    expect(await readLatestAudit(naoAuditada.rest, KEY)).toEqual({ status: 'nao_auditada', reason: 'claude_falhou', refusals: REFUSALS });
    const audited = scripted((c) => ({
      body: c.table === 'proposal_level_changes' ? [{ to_level: 'coordenacao' }] : [{
        id: 12, status: 'audited', reason: null, classification: 'E2', dock_action: { kind: 'recusar' }, routing: 'coordenacao',
        justification: 'a\nb', amount_at_risk_cents: null, model: 'm', audited_at: '2026-11-15T18:30:00+00:00',
        differing_fields: ['classification', 'routing'], requested_level: 'diretoria', requested_from_level: 'analista',
        injection_flag: null, refusals: [],
      }],
    }));
    expect(await readLatestAudit(audited.rest, KEY)).toEqual({
      status: 'auditada', classification: 'E2', dockAction: 'recusar', routing: 'coordenacao', justification: 'a\nb',
      amountAtRiskCents: null, model: 'm', auditedAt: '2026-11-15T18:30:00.000Z', differs: ['classification', 'routing'],
      raisedLevel: 'coordenacao', injectionFlag: null, refusals: [],
    });
  });

  it('#230/AC-3: o raisedLevel é o nível aplicado, lido de proposal_level_changes pela auditoria, em uma leitura a mais', async () => {
    const audited = scripted((c) => ({
      body: c.table === 'proposal_level_changes' ? [{ to_level: 'diretoria' }] : [{ ...EMPTY_ROW, id: 12, ...AUDITED_FIELDS, requested_level: 'diretoria', requested_from_level: 'analista' }],
    }));
    const latest = await readLatestAudit(audited.rest, KEY);
    expect(latest).toMatchObject({ status: 'auditada', raisedLevel: 'diretoria' });
    expect(audited.calls.map((c) => c.table)).toEqual(['invoice_audits', 'proposal_level_changes']);
    const read = audited.calls[1];
    expect(read?.params.get('invoice_audit_id')).toBe('eq.12');
    expect(read?.params.get('changed_by')).toBe('eq.invoice-audit');
    expect(read?.params.get('order')).toBe('id.desc');
    expect(read?.params.get('limit')).toBe('1');
  });

  it('#230/AC-4: pedido sem subida aplicada: raisedLevel é null, ainda que a linha da auditoria registre o pedido', async () => {
    const audited = scripted((c) => ({
      body: c.table === 'proposal_level_changes' ? [] : [{ ...EMPTY_ROW, id: 12, ...AUDITED_FIELDS, requested_level: 'diretoria', requested_from_level: 'analista' }],
    }));
    expect(await readLatestAudit(audited.rest, KEY)).toMatchObject({ status: 'auditada', raisedLevel: null });
  });

  it('#230/AC-7: a auditoria feita vence uma nao_auditada posterior: a ordem põe audited antes e o limite de uma linha a pega', async () => {
    const auditedRow = {
      id: 3, status: 'audited', reason: null, classification: 'E2', dock_action: { kind: 'recusar' }, routing: 'coordenacao',
      justification: 'a', amount_at_risk_cents: null, model: 'm', audited_at: '2026-11-15T18:30:00Z',
      differing_fields: [], requested_level: null, requested_from_level: null, injection_flag: null, refusals: [],
    };
    const later = { ...EMPTY_ROW, status: 'nao_auditada', reason: 'claude_falhou' };
    const { rest } = scripted((c) => {
      const order = c.params.get('order');
      // #230 O banco ordena por status asc ('audited' < 'nao_auditada'), depois id desc; limit 1.
      if (c.table !== 'invoice_audits') return { body: [] };
      return { body: [order === 'status.asc,id.desc' ? auditedRow : later] };
    });
    const latest = await readLatestAudit(rest, KEY);
    expect(latest?.status).toBe('auditada');
  });

  it('#230: uma linha fora do formato falha com erro de leitura, sem os dados', async () => {
    const { rest } = scripted(() => ({ body: [{ id: 1, status: 'audited', justification: SEGREDO }] }));
    const error = await readLatestAudit(rest, KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(SEGREDO);
  });
});
