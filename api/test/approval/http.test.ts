import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryApprovalStore, type CaseFile } from '../../src/approval/store.js';
import { draftProposal, propose } from '../../src/domain/approval.js';
import { ApprovalPolicy } from '../../src/domain/approval-policy.js';
import { Title, type Invoice, type Product } from '../../src/domain/index.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { todayInBrasilia } from '../../src/http/approval.js';
import { createWorker } from '../../src/index.js';
import { checkedWith, kitInvoice, kitSupplier } from './kit.js';

const TODAY = '2026-11-15';
const ANALISTA = 'analista@jachegou.test';
const COORDENACAO = 'Coordenacao@JaChegou.test';
const DIRETORIA = 'diretoria@jachegou.test';

const env: Env = {
  ACCESS_AUD: 'aud',
  ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com',
  APPROVER_LEVELS: JSON.stringify({
    [ANALISTA]: 'analista',
    'coordenacao@jachegou.test': 'coordenacao',
    [DIRETORIA]: 'diretoria',
    'regra@jachegou.test': 'regra',
  }),
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

/** O token é o e-mail: o Access já foi testado no access.test.ts (#54). */
const verifier: AccessVerifier = {
  async verify(token) {
    return { ok: true, identity: { email: token === 'service' ? null : token } };
  },
};

function caseFile(invoice: Invoice): CaseFile {
  const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: '2026-12-10' });
  const route = ApprovalPolicy.route(invoice, kitSupplier(invoice.supplierId));
  const { proposal, approval } = propose(invoice, title, { route, ...draftProposal(invoice, null), today: TODAY });
  return { invoice, proposal, title, route, approval, supplierBlocked: kitSupplier(invoice.supplierId)?.paymentBlocked ?? false };
}

/** Um caso de cada nível, da base do kit. */
function seeded() {
  const files = {
    match: caseFile(checkedWith(kitInvoice('NF-036'))),
    analista: caseFile(checkedWith(kitInvoice('NF-008'), 'E4')),
    coordenacao: caseFile(checkedWith(kitInvoice('NF-029'), 'E5')),
    bloqueio: caseFile(checkedWith(kitInvoice('NF-012'), 'E6')),
    diretoria: caseFile(checkedWith(kitInvoice('NF-003'))),
  };
  const store = new MemoryApprovalStore(Object.values(files));
  const worker = createWorker({ verifier, approval: { store, today: () => TODAY } });
  const call = (path: string, as: string, init: { method?: string; body?: unknown } = {}) =>
    worker.fetch(
      new Request(`https://worker.test${path}`, {
        method: init.method ?? 'GET',
        headers: { 'Cf-Access-Jwt-Assertion': as, 'Content-Type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      env,
      ctx,
    );
  const key = (k: keyof typeof files) => files[k].invoice.accessKey;
  return { files, call, key };
}

type QueueBody = { approver: { level: string | null }; items: { invoiceAccessKey: string; level: string; canApprove: boolean }[] };

describe('GET /api/fila', () => {
  it('AC-6: quem aprova encontra as propostas que aguardam, com o que pode aprovar marcado', async () => {
    const { call, key } = seeded();
    const res = await call('/api/fila', ANALISTA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as QueueBody;
    expect(body.approver.level).toBe('analista');
    const keys = body.items.map((i) => i.invoiceAccessKey);
    expect(keys).toEqual(expect.arrayContaining([key('analista'), key('coordenacao'), key('bloqueio'), key('diretoria')]));
    expect(keys).not.toContain(key('match'));
    const can = Object.fromEntries(body.items.map((i) => [i.invoiceAccessKey, i.canApprove]));
    expect(can[key('analista')]).toBe(true);
    expect(can[key('coordenacao')]).toBe(false);
  });

  it('pede o Access: sem token é 401', async () => {
    const worker = createWorker({ verifier });
    const res = await worker.fetch(new Request('https://worker.test/api/fila'), env, ctx);
    expect(res.status).toBe(401);
  });

  it('o e-mail é comparado sem diferença de maiúsculas', async () => {
    const { call } = seeded();
    const body = (await (await call('/api/fila', COORDENACAO)).json()) as QueueBody;
    expect(body.approver.level).toBe('coordenacao');
  });
});

describe('exceptionCode e exceptionName (#128/AC-4)', () => {
  it('a fila devolve o código e o nome da exceção de cada proposta', async () => {
    const { call, key } = seeded();
    const body = (await (await call('/api/fila', ANALISTA)).json()) as {
      items: { invoiceAccessKey: string; exceptionCode: string; exceptionName: string }[];
    };
    const item = (k: Parameters<typeof key>[0]) => body.items.find((i) => i.invoiceAccessKey === key(k));
    expect(item('analista')).toMatchObject({ exceptionCode: 'E4', exceptionName: 'Unidade de medida' });
    expect(item('bloqueio')).toMatchObject({ exceptionCode: 'E6', exceptionName: 'Duplicidade' });
  });

  it('a proposta devolve o nome também em cada divergência', async () => {
    const { call, key } = seeded();
    const body = (await (await call(`/api/propostas/${key('bloqueio')}`, ANALISTA)).json()) as {
      exceptionCode: string;
      exceptionName: string;
      divergences: { exceptionCode: string; exceptionName: string }[];
    };
    expect(body).toMatchObject({ exceptionCode: 'E6', exceptionName: 'Duplicidade' });
    expect(body.divergences.length).toBeGreaterThan(0);
    for (const d of body.divergences) expect(d).toMatchObject({ exceptionCode: 'E6', exceptionName: 'Duplicidade' });
  });
});

describe('GET /api/hoje (#128)', () => {
  it('cada título da lista do dia leva o código e o nome da exceção', async () => {
    const { files, call } = seeded();
    const f = files.analista;
    await call(`/api/propostas/${f.invoice.accessKey}/aprovar`, DIRETORIA, { method: 'POST', body: {} });
    const body = (await (await call(`/api/hoje?dia=${TODAY}`, ANALISTA)).json()) as {
      items: { invoiceAccessKey: string; exceptionCode: string; exceptionName: string }[];
    };
    expect(body.items.find((i) => i.invoiceAccessKey === f.invoice.accessKey)).toMatchObject({
      exceptionCode: 'E4',
      exceptionName: 'Unidade de medida',
    });
  });
});

describe('GET /api/propostas/:chave', () => {
  it('chave com escape malformado é 400', async () => {
    const { call } = seeded();
    expect((await call('/api/propostas/%E0%A4%A', ANALISTA)).status).toBe(400);
  });

  it('AC-12: mostra a evidência de cada divergência e o valor em risco, entre zero e o valor da nota', async () => {
    const { call, key } = seeded();
    const res = await call(`/api/propostas/${key('bloqueio')}`, ANALISTA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      divergences: { classification: string; evidence: unknown[] }[];
      amountAtRisk: { cents: number };
      total: { cents: number };
      level: string;
      requiredApproverLevel: string;
    };
    expect(body.divergences).toHaveLength(1);
    for (const d of body.divergences) expect(d.evidence.length).toBeGreaterThan(0);
    expect(body.amountAtRisk.cents).toBeGreaterThanOrEqual(0);
    expect(body.amountAtRisk.cents).toBeLessThanOrEqual(body.total.cents);
    expect(body.level).toBe('bloqueio');
    expect(body.requiredApproverLevel).toBe('coordenacao');
  });

  it('nota desconhecida é 404', async () => {
    const { call } = seeded();
    expect((await call('/api/propostas/nao-existe', ANALISTA)).status).toBe(404);
  });
});

describe('POST /api/propostas/:chave/aprovar', () => {
  it('AC-7: abaixo do nível é 403 e a proposta segue aguardando', async () => {
    const { call, key, files } = seeded();
    const res = await call(`/api/propostas/${key('coordenacao')}/aprovar`, ANALISTA, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(files.coordenacao.proposal.state).toBe('aguardando_aprovacao');
  });

  it('AC-7: e-mail sem nível, ou com nível que não é de pessoa, não aprova', async () => {
    const { call, key } = seeded();
    expect((await call(`/api/propostas/${key('analista')}/aprovar`, 'outra@jachegou.test', { method: 'POST' })).status).toBe(403);
    expect((await call(`/api/propostas/${key('analista')}/aprovar`, 'regra@jachegou.test', { method: 'POST' })).status).toBe(403);
    expect((await call(`/api/propostas/${key('analista')}/aprovar`, 'service', { method: 'POST' })).status).toBe(403);
  });

  it('AC-8 e AC-11: aprova uma vez só; a segunda é 409; o título vai para a lista do dia', async () => {
    const { call, key } = seeded();
    const first = await call(`/api/propostas/${key('analista')}/aprovar`, ANALISTA, { method: 'POST' });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { title: { state: string } }).title.state).toBe('na_lista_do_dia');
    const second = await call(`/api/propostas/${key('analista')}/aprovar`, DIRETORIA, { method: 'POST' });
    expect(second.status).toBe(409);
  });

  it('AC-4: a nota acima de R$ 100 mil só a diretoria aprova', async () => {
    const { call, key } = seeded();
    expect((await call(`/api/propostas/${key('diretoria')}/aprovar`, COORDENACAO, { method: 'POST' })).status).toBe(403);
    expect((await call(`/api/propostas/${key('diretoria')}/aprovar`, DIRETORIA, { method: 'POST' })).status).toBe(200);
  });

  it('AC-10: a duplicidade é resolvida pela coordenação e o título fica bloqueado', async () => {
    const { call, key } = seeded();
    expect((await call(`/api/propostas/${key('bloqueio')}/aprovar`, ANALISTA, { method: 'POST' })).status).toBe(403);
    const res = await call(`/api/propostas/${key('bloqueio')}/aprovar`, COORDENACAO, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: { state: string } }).title.state).toBe('bloqueado');
  });

  it('GET em aprovar é 405', async () => {
    const { call, key } = seeded();
    expect((await call(`/api/propostas/${key('analista')}/aprovar`, ANALISTA)).status).toBe(405);
  });
});

describe('POST /api/propostas/:chave/alterar', () => {
  it('AC-9: alterar sem justificativa é 422 e nada muda', async () => {
    const { call, key, files } = seeded();
    const res = await call(`/api/propostas/${key('analista')}/alterar`, ANALISTA, {
      method: 'POST',
      body: { dockAction: { kind: 'recusar' }, justification: '   ' },
    });
    expect(res.status).toBe(422);
    expect(files.analista.proposal.state).toBe('aguardando_aprovacao');
  });

  it('AC-11: alterar para recusar, com justificativa, bloqueia o título', async () => {
    const { call, key } = seeded();
    const res = await call(`/api/propostas/${key('analista')}/alterar`, ANALISTA, {
      method: 'POST',
      body: { dockAction: { kind: 'recusar' }, justification: 'o fornecedor vai reemitir a nota' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approval: { justification: string }; title: { state: string } };
    expect(body.title.state).toBe('bloqueado');
    expect(body.approval.justification).toBe('o fornecedor vai reemitir a nota');
  });

  it('AC-11: alterar para receber parcial reduz o título', async () => {
    const { call, key, files } = seeded();
    const res = await call(`/api/propostas/${key('analista')}/alterar`, ANALISTA, {
      method: 'POST',
      body: {
        dockAction: { kind: 'receber_parcial', lines: [{ sku: 'SKU-1024', quantity: { amount: 10, unit: 'UN' }, disposition: 'devolver' }] },
        justification: 'devolve 10 UN avariadas',
      },
    });
    expect(res.status).toBe(200);
    // NF-008: 10 UN do SKU-1024 a R$ 7,89 saem do título.
    expect(files.analista.title.amount.cents).toBe(files.analista.invoice.total.cents - 7_890);
    expect(files.analista.title.state).toBe('na_lista_do_dia');
  });

  it('receber parcial com linha fora da nota é 422', async () => {
    const { call, key, files } = seeded();
    const res = await call(`/api/propostas/${key('analista')}/alterar`, ANALISTA, {
      method: 'POST',
      body: {
        dockAction: { kind: 'receber_parcial', lines: [{ sku: 'SKU-9999', quantity: { amount: 1, unit: 'UN' }, disposition: 'devolver' }] },
        justification: 'x',
      },
    });
    expect(res.status).toBe(422);
    expect(files.analista.proposal.state).toBe('aguardando_aprovacao');
  });

  it('ação na doca inválida é 422', async () => {
    const { call, key } = seeded();
    const res = await call(`/api/propostas/${key('analista')}/alterar`, ANALISTA, {
      method: 'POST',
      body: { dockAction: { kind: 'pagar' }, justification: 'x' },
    });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/hoje', () => {
  type Today = { day: string; items: { invoiceAccessKey: string }[] };

  it('AC-13 e AC-1: mostra os liberados do dia, inclusive o match da regra, e nenhum bloqueado ou sem decisão', async () => {
    const { call, key } = seeded();
    await call(`/api/propostas/${key('analista')}/aprovar`, ANALISTA, { method: 'POST' });
    await call(`/api/propostas/${key('bloqueio')}/aprovar`, COORDENACAO, { method: 'POST' });
    const body = (await (await call('/api/hoje', ANALISTA)).json()) as Today;
    expect(body.day).toBe(TODAY);
    const keys = body.items.map((i) => i.invoiceAccessKey);
    expect(keys).toEqual(expect.arrayContaining([key('match'), key('analista')]));
    expect(keys).not.toContain(key('bloqueio'));
    expect(keys).not.toContain(key('coordenacao'));
    expect(keys).not.toContain(key('diretoria'));
  });

  it('outro dia não traz os de hoje; dia mal formado é 400', async () => {
    const { call } = seeded();
    const body = (await (await call('/api/hoje?dia=2026-11-14', ANALISTA)).json()) as Today;
    expect(body.items).toEqual([]);
    expect((await call('/api/hoje?dia=ontem', ANALISTA)).status).toBe(400);
  });

  it('o dia de hoje é o de Brasília', () => {
    expect(todayInBrasilia(new Date('2026-11-15T02:00:00Z'))).toBe('2026-11-14');
  });
});

describe('quantidade na unidade de estoque (#176/AC-2)', () => {
  it('E4: cada item em caixa traz a quantidade em UN pelo fator do cadastro; item em UN fica igual', async () => {
    const { files, key } = seeded();
    const factors = new Map(
      (JSON.parse(readFileSync(new URL('../../../data/kit/produtos.json', import.meta.url), 'utf8')) as {
        sku: string;
        fator_caixa: number;
      }[]).map((p) => [p.sku, p.fator_caixa]),
    );
    const products = async () =>
      [...factors].map(([sku, boxFactor]) => ({ sku, boxFactor }) as unknown as Product);
    const worker = createWorker({ verifier, approval: { store: new MemoryApprovalStore(Object.values(files)), today: () => TODAY, products } });
    const res = await worker.fetch(
      new Request(`https://worker.test/api/propostas/${key('analista')}`, { headers: { 'Cf-Access-Jwt-Assertion': ANALISTA } }),
      env,
      ctx,
    );
    const body = (await res.json()) as { items: { sku: string; quantity: { amount: number; unit: string }; stockQuantity: { amount: number; unit: string } | null }[] };
    const cx = body.items.find((i) => i.sku === 'SKU-1025')!;
    expect(cx.quantity).toEqual({ amount: 232, unit: 'CX' });
    expect(cx.stockQuantity).toEqual({ amount: 232 * factors.get('SKU-1025')!, unit: 'UN' });
  });

  it('sem o cadastro à mão, a unidade de estoque vai nula e a proposta continua abrindo', async () => {
    const { call, key } = seeded();
    const body = (await (await call(`/api/propostas/${key('analista')}`, ANALISTA)).json()) as { items: { stockQuantity: unknown }[] };
    for (const i of body.items) expect(i.stockQuantity).toBeNull();
  });
});
