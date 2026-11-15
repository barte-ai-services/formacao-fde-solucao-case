import { describe, expect, it } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { approve, propose } from '../../src/domain/approval.js';
import { ApprovalPolicy } from '../../src/domain/approval-policy.js';
import { CHECKS } from '../../src/domain/checks/index.js';
import { priceDifference } from '../../src/domain/checks/nao-catalogada.js';
import { draftChecked } from '../../src/domain/draft-checked.js';
import { Divergence, Invoice, Money, Title, type CheckContext, type DockAction } from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

/** #56: a base do kit pelos conectores offline, com a contagem do WMS no contexto. */
async function kit() {
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: new FakePostgrest(kitTables()).fetch });
  const { captureDeps: d } = supabaseConnectors(rest);
  const [invoices, purchaseOrders, suppliers, products, postedInvoices, payments, receipts] = await Promise.all([
    d.sefaz.listIssuedInvoices(),
    d.purchasing.listPurchaseOrders(),
    d.registry.listSuppliers(),
    d.registry.listProducts(),
    d.payables.listPostedInvoices(),
    d.bank.listPayments(),
    d.wms.listReceipts(),
  ]);
  const ctx: CheckContext = { purchaseOrders, suppliers, products, postedInvoices, payments, receipts, capturedInvoices: [] };
  const checked = (number: string): Invoice => {
    const invoice = invoices.find((i) => i.number === number)!;
    invoice.check({ ...ctx, capturedInvoices: invoices.filter((i) => i !== invoice) });
    return invoice;
  };
  return { ctx, checked, invoices };
}


const draftOf = (invoice: Invoice, ctx: CheckContext) =>
  draftChecked(invoice, ctx, priceDifference(invoice, ctx)?.overcharge ?? null);

const linesOf = (action: DockAction) =>
  action.kind === 'receber_parcial'
    ? action.lines.map((l) => `${l.sku} ${l.quantity.amount} ${l.quantity.unit} ${l.disposition}`)
    : [];

describe('#56 a proposta de cada exceção liga ao que a história dela construiu (casos do kit)', () => {
  it('#56 E1 (#69): nota 72741 recebe parcial segurando o item que não chegou, com o valor dele em risco', async () => {
    const { ctx, checked } = await kit();
    const invoice = checked('72741');
    expect(invoice.classification).toBe('E1');
    const draft = draftOf(invoice, ctx);
    expect(draft.dockAction.kind).toBe('receber_parcial');
    expect(linesOf(draft.dockAction)).toEqual(['SKU-1004 112 UN segurar']);
    expect(draft.amountAtRisk.cents).toBe(138_880);
  });

  it('#56 E2 (#70): nota 43894 recebe parcial segurando o item trocado, com o valor dele em risco', async () => {
    const { ctx, checked } = await kit();
    const invoice = checked('43894');
    expect(invoice.classification).toBe('E2');
    const draft = draftOf(invoice, ctx);
    expect(linesOf(draft.dockAction)).toEqual(['SKU-1005 192 UN segurar']);
    expect(draft.amountAtRisk.cents).toBe(53_568);
  });

  it('#56 E2, regra 6: nota 13696, cujo único item é o trocado, é recusada com o valor da nota em risco', async () => {
    const { ctx, checked } = await kit();
    const invoice = checked('13696');
    expect(invoice.classification).toBe('E2');
    const draft = draftOf(invoice, ctx);
    expect(draft.dockAction.kind).toBe('recusar');
    expect(draft.amountAtRisk.cents).toBe(212_576);
  });

  it('#56 E3 (#73): nota 37423 recebe parcial devolvendo a diferença, com a diferença em risco', async () => {
    const { ctx, checked } = await kit();
    const invoice = checked('37423');
    expect(invoice.classification).toBe('E3');
    const draft = draftOf(invoice, ctx);
    expect(linesOf(draft.dockAction)).toEqual(['SKU-1024 25 UN devolver']);
    expect(draft.amountAtRisk.cents).toBe(19_725);
  });

  it('#56 E4 (#67), regra 4: nota 37452 recebe, com o valor em risco que a verificação do E4 calcula', async () => {
    const { ctx, checked } = await kit();
    const invoice = checked('37452');
    expect(invoice.classification).toBe('E4');
    const draft = draftOf(invoice, ctx);
    expect(draft.dockAction.kind).toBe('receber');
    // #56, regra 4: a caixa convertida bate com a ordem, então o E4 não acha cobrança a mais.
    expect(draft.amountAtRisk.cents).toBe(0);
  });

  it('#56 E8 (#66): nota 48063 recebe parcial segurando o item sem cadastro, e a aprovação reduz o título por ele', async () => {
    const { ctx, checked } = await kit();
    const invoice = checked('48063');
    expect(invoice.classification).toBe('E8');
    const draft = draftOf(invoice, ctx);
    expect(linesOf(draft.dockAction)).toEqual(['F04-N42 20 UN segurar']);
    expect(draft.amountAtRisk.cents).toBe(47_800);

    const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: '2026-11-20' });
    const route = ApprovalPolicy.route(invoice, ctx.suppliers.find((s) => s.id === invoice.supplierId));
    const { proposal } = propose(invoice, title, { route, ...draft, today: '2026-11-15' });
    approve(invoice, proposal, title, { email: 'diretoria@jachegou.test', level: 'diretoria' }, { kind: 'aprovar' }, '2026-11-15');
    expect(title.state).toBe('na_lista_do_dia');
    expect(title.amount.cents).toBe(233_520 - 47_800);
  });

  it('#56, regra 6: com várias divergências, soma o valor em risco limitado ao da nota e fica com a ação mais restritiva', async () => {
    const { ctx } = await kit();
    const base = (await kit()).checked('37423');
    const invoice = Invoice.receive({
      accessKey: base.accessKey,
      number: base.number,
      series: base.series,
      supplierId: base.supplierId,
      store: base.store,
      issuedOn: base.issuedOn,
      purchaseOrderRef: base.purchaseOrderRef,
      entryChannel: base.entryChannel,
      items: base.items,
      total: base.total,
    });
    // #56: uma diferença de preço a mais, cobrando o dobro da nota, junto do E3 real da contagem.
    const overpriced = {
      id: 'NAO_CATALOGADA' as const,
      run: () => [
        Divergence.of({
          classification: 'NAO_CATALOGADA',
          skus: ['SKU-1026'],
          evidence: [{ source: 'erp_compras', reference: 'OC', description: 'preço acima da ordem' }],
        }),
      ],
    };
    invoice.check(ctx, [...CHECKS.filter((c) => c.id !== 'NAO_CATALOGADA'), overpriced]);
    expect(invoice.divergences.map((d) => d.classification).sort()).toEqual(['E3', 'NAO_CATALOGADA']);
    const draft = draftChecked(invoice, ctx, Money.ofCents(invoice.total.cents * 2));
    expect(draft.amountAtRisk.cents).toBe(invoice.total.cents);
    expect(linesOf(draft.dockAction)).toEqual(['SKU-1024 25 UN devolver']);
  });

  it('#56: match, duplicidade e pago fora do fluxo seguem a proposta do #63 e do #64', async () => {
    const { ctx, checked } = await kit();
    const invoice = checked('70585');
    expect(invoice.classification).toBe('MATCH');
    const draft = draftOf(invoice, ctx);
    expect(draft.dockAction.kind).toBe('receber');
    expect(draft.amountAtRisk.cents).toBe(0);
  });
});

describe('#56 toda proposta de exceção do kit é aceita pela aprovação (#63)', () => {
  it('#56: em cada nota E1, E2, E3 e E8 do kit, aprovar a proposta reduz ou bloqueia o título sem lançar', async () => {
    const { ctx, invoices } = await kit();
    let seen = 0;
    for (const invoice of invoices) {
      invoice.check({ ...ctx, capturedInvoices: invoices.filter((i) => i !== invoice) });
      if (!['E1', 'E2', 'E3', 'E8'].includes(invoice.classification)) continue;
      seen += 1;
      const draft = draftOf(invoice, ctx);
      const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: '2026-11-20' });
      const route = ApprovalPolicy.route(invoice, ctx.suppliers.find((s) => s.id === invoice.supplierId));
      const { proposal } = propose(invoice, title, { route, ...draft, today: '2026-11-15' });
      approve(invoice, proposal, title, { email: 'diretoria@jachegou.test', level: 'diretoria' }, { kind: 'aprovar' }, '2026-11-15');
      const expected = draft.dockAction.kind === 'recusar' ? 'bloqueado' : 'na_lista_do_dia';
      expect([invoice.number, title.state]).toEqual([invoice.number, expected]);
      if (draft.dockAction.kind === 'receber_parcial') expect(title.amount.compare(invoice.total)).toBeLessThan(0);
    }
    expect(seen).toBe(36);
  });
});

describe('#56 o Cron grava a proposta de cada exceção com a contagem do WMS', () => {
  it('#56: com o WMS, as 80 notas são propostas e E1, E2, E3 e E8 saem com receber parcial e valor em risco', async () => {
    const fake = new FakePostgrest(kitTables());
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    const { captureDeps } = supabaseConnectors(rest);
    await captureInvoices(captureDeps);
    const result = await proposeChecked({
      rest,
      purchasing: captureDeps.purchasing,
      registry: captureDeps.registry,
      wms: captureDeps.wms,
      now: () => new Date('2026-11-15T12:00:00Z'),
    });
    expect(result.proposed).toBe(80);
    const rows = fake.rows('proposals');
    for (const code of ['E1', 'E2', 'E3', 'E8']) {
      const ofCode = rows.filter((r) => r.classification === code);
      expect(ofCode.length).toBeGreaterThan(0);
      expect(ofCode.every((r) => Number(r.amount_at_risk_cents) > 0)).toBe(true);
      expect(ofCode.some((r) => JSON.stringify(r.dock_action).includes('receber_parcial'))).toBe(true);
    }
  });
});
