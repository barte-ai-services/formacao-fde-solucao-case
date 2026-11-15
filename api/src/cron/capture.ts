// Captura do Cron: lê a SEFAZ, grava as notas novas e confere as que estão a conferir (#59, AC-5).
import type { CheckContext, Invoice } from '../domain/index.js';
import type { InvoiceStore } from '../connectors/invoice-store.js';
import type {
  BankPort,
  PayablesPort,
  PurchasingPort,
  RegistryPort,
  SefazPort,
  WmsCountPort,
} from '../connectors/ports.js';

export type CaptureDeps = {
  readonly sefaz: SefazPort;
  readonly purchasing: PurchasingPort;
  readonly payables: PayablesPort;
  readonly registry: RegistryPort;
  readonly bank: BankPort;
  readonly wms: WmsCountPort;
  readonly invoices: InvoiceStore;
  readonly now?: () => Date;
};

export type CaptureResult = {
  /** #59 Notas que a SEFAZ devolveu. */
  readonly seen: number;
  /** #59 Notas novas gravadas nesta rodada (regra 1: a chave repetida não entra de novo). */
  readonly inserted: number;
  /** #59 Notas conferidas nesta rodada. */
  readonly checked: number;
};

/** #59 Idempotente: a segunda rodada sobre a mesma SEFAZ não grava nem confere nada de novo. */
export async function captureInvoices(deps: CaptureDeps): Promise<CaptureResult> {
  const issued = await deps.sefaz.listIssuedInvoices();
  const inserted = await deps.invoices.insertNew(issued);
  const pending = new Set(await deps.invoices.listPendingKeys());
  const toCheck = issued.filter((i) => pending.has(i.accessKey));
  if (toCheck.length > 0) {
    const ctx = await buildContext(deps, issued);
    for (const invoice of toCheck) {
      // #59 Regra 1: a nota não é duplicada de si mesma; a E6 compara com as outras capturadas.
      invoice.check({ ...ctx, capturedInvoices: ctx.capturedInvoices.filter((o) => o.accessKey !== invoice.accessKey) });
    }
    await deps.invoices.saveChecked(toCheck, (deps.now ?? (() => new Date()))().toISOString());
  }
  return { seen: issued.length, inserted: inserted.length, checked: toCheck.length };
}

async function buildContext(deps: CaptureDeps, captured: readonly Invoice[]): Promise<CheckContext> {
  const [purchaseOrders, suppliers, products, postedInvoices, payments, receipts] = await Promise.all([
    deps.purchasing.listPurchaseOrders(),
    deps.registry.listSuppliers(),
    deps.registry.listProducts(),
    deps.payables.listPostedInvoices(),
    deps.bank.listPayments(),
    deps.wms.listReceipts(),
  ]);
  return { purchaseOrders, suppliers, products, postedInvoices, payments, receipts, capturedInvoices: captured };
}
