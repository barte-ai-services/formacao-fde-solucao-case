import { describe, expect, it } from 'vitest';
import { settleApprovedE3Shortfall } from '../../src/connectors/e3-return-note.js';
import type { ReturnNoteOutbox } from '../../src/connectors/ports.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import {
  isShortLine,
  checkQuantidadeMenor,
  proposeE3,
} from '../../src/domain/checks/e3-quantidade-menor.js';
import {
  Money,
  Proposal,
  Quantity,
  Title,
  reconcile,
  type CheckContext,
} from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

async function kit() {
  const fake = new FakePostgrest(kitTables());
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { captureDeps: d, returnNotes } = supabaseConnectors(rest);
  const [invoices, purchaseOrders, suppliers, products, postedInvoices, payments, receipts] = await Promise.all([
    d.sefaz.listIssuedInvoices(),
    d.purchasing.listPurchaseOrders(),
    d.registry.listSuppliers(),
    d.registry.listProducts(),
    d.payables.listPostedInvoices(),
    d.bank.listPayments(),
    d.wms.listReceipts(),
  ]);
  const ctx: CheckContext = { purchaseOrders, suppliers, products, postedInvoices, payments, receipts, capturedInvoices: invoices };
  const caseOf = (receiptId: string) => {
    const receipt = receipts.find((r) => r.id === receiptId)!;
    const invoice = invoices.find((i) => i.accessKey === receipt.invoiceAccessKey)!;
    return { receipt, invoice, lines: reconcile(invoice, receipt, products) };
  };
  return { fake, ctx, returnNotes, caseOf };
}

const check = checkQuantidadeMenor;

// #73: dados de base do kit (notas.json, recebimentos.json): faturado, contado e o valor do item.
const E3_CASES = [
  { receipt: 'RC-9219', number: '37423', code: 'F08-001', invoiced: 100, counted: 75, itemValue: 789.0, level: 'analista' },
  { receipt: 'RC-9228', number: '72768', code: 'F01-001', invoiced: 88, counted: 66, itemValue: 430.32, level: 'analista' },
  { receipt: 'RC-9241', number: '47963', code: 'F04-001', invoiced: 1432, counted: 1074, itemValue: 3565.68, level: 'analista' },
  { receipt: 'RC-9250', number: '43900', code: 'F02-003', invoiced: 336, counted: 252, itemValue: 5006.4, level: 'analista' },
  { receipt: 'RC-9268', number: '84433', code: 'F10-002', invoiced: 328, counted: 246, itemValue: 8167.2, level: 'coordenacao' },
  { receipt: 'RC-9270', number: '89408', code: 'F03-003', invoiced: 11064, counted: 8298, itemValue: 37617.6, level: 'diretoria' },
] as const;

const expectedRiskCents = (c: (typeof E3_CASES)[number]) =>
  Math.round((Money.fromReais(c.itemValue).cents * (c.invoiced - c.counted)) / c.invoiced);

describe('#73 E3 quantidade menor nos recebimentos do kit (offline)', () => {
  for (const c of E3_CASES) {
    it(`#73/AC-1, regras 4 e 6: ${c.receipt} (nota ${c.number}) contou ${c.counted} de ${c.invoiced} e marca E3`, async () => {
      const { ctx, caseOf } = await kit();
      const { invoice } = caseOf(c.receipt);
      const [d, ...rest] = check(invoice, ctx);
      expect(rest).toEqual([]);
      expect(d?.classification).toBe('E3');
      expect(d?.evidence.find((e) => e.source === 'wms')).toMatchObject({ reference: c.receipt });
      expect(d?.evidence.find((e) => e.source === 'erp_compras')?.reference).toBe(invoice.purchaseOrderRef);
    });

    it(`#73/AC-2, regra 6: ${c.receipt} propõe receber parcial, devolvendo ${c.invoiced - c.counted}, com valor em risco igual à diferença`, async () => {
      const { ctx, caseOf } = await kit();
      const { invoice, lines } = caseOf(c.receipt);
      const props = proposeE3(invoice, ctx, lines);
      expect(props.dockAction.kind).toBe('receber_parcial');
      const dockLines = props.dockAction.kind === 'receber_parcial' ? props.dockAction.lines : [];
      expect(dockLines).toHaveLength(1);
      expect(dockLines[0]?.disposition).toBe('devolver');
      expect(dockLines[0]?.quantity.equals(Quantity.of(c.invoiced - c.counted, 'UN'))).toBe(true);
      expect(props.amountAtRisk.amount.cents).toBe(expectedRiskCents(c));
      expect(props.level).toBe(c.level);
    });

    it(`#73/AC-3 e AC-4: ${c.receipt} aprovado reduz o título ao recebido e publica a devolução na caixa de saída do ERP`, async () => {
      const { ctx, caseOf, returnNotes, fake } = await kit();
      const { invoice, lines } = caseOf(c.receipt);
      const proposal = Proposal.register(proposeE3(invoice, ctx, lines));
      proposal.awaitApproval();
      proposal.approve();
      const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: '2026-12-10' });
      const published = await settleApprovedE3Shortfall({ proposal, title, invoice, lines, outbox: returnNotes });

      expect(title.state).toBe('reduzido');
      expect(title.amount.cents).toBe(invoice.total.cents - expectedRiskCents(c));

      const [note, ...others] = await returnNotes.list();
      expect(others).toEqual([]);
      expect(note).toMatchObject({ id: published.id, invoiceAccessKey: invoice.accessKey });
      expect(note?.lines).toHaveLength(1);
      expect(note?.lines[0]?.supplierCode).toBe(c.code);
      expect(note?.lines[0]?.quantity.equals(Quantity.of(c.invoiced - c.counted, 'UN'))).toBe(true);

      await returnNotes.publish(published);
      expect(fake.rows('outbox_return_notes')).toHaveLength(1);
    });
  }

  it('#73/AC-3 e AC-4: RC-9219, publicar a devolução falha e o título fica lançado; a nova tentativa liquida', async () => {
    const { ctx, caseOf, returnNotes, fake } = await kit();
    const { invoice, lines } = caseOf('RC-9219');
    const proposal = Proposal.register(proposeE3(invoice, ctx, lines));
    proposal.awaitApproval();
    proposal.approve();
    const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: '2026-12-10' });
    const failing: ReturnNoteOutbox = {
      publish: () => Promise.reject(new Error('caixa de saída fora do ar')),
      list: () => returnNotes.list(),
    };

    await expect(settleApprovedE3Shortfall({ proposal, title, invoice, lines, outbox: failing })).rejects.toThrow();
    expect(title.state).toBe('lancado');
    expect(fake.rows('outbox_return_notes')).toHaveLength(0);

    await settleApprovedE3Shortfall({ proposal, title, invoice, lines, outbox: returnNotes });
    expect(title.state).toBe('reduzido');
    expect(fake.rows('outbox_return_notes')).toHaveLength(1);
  });

  it('#73/AC-1: RC-9107, com a contagem batendo com a nota, não marca E3', async () => {
    const { ctx, caseOf } = await kit();
    const { invoice, lines } = caseOf('RC-9107');
    expect(lines.some(isShortLine)).toBe(false);
    expect(check(invoice, ctx)).toEqual([]);
  });

  it('#73/AC-1: RC-9148, com item contado zero, não marca E3 (é falta física, E1)', async () => {
    const { ctx, caseOf } = await kit();
    expect(check(caseOf('RC-9148').invoice, ctx)).toEqual([]);
  });
});
