import type { CaptureDeps } from '../cron/capture.js';
import type { CheckContext } from '../domain/index.js';

// #68: o contexto da nota para o catálogo do dossiê, lido pelos conectores do #80.

/** #68: os conectores que o contexto lê. */
export type DossierContextDeps = Pick<CaptureDeps, 'sefaz' | 'purchasing' | 'payables' | 'registry' | 'bank' | 'wms'>;

/** #68: monta o contexto como a captura monta, sem a própria nota entre as capturadas (regra 1). */
export async function loadDossierContext(deps: DossierContextDeps, invoiceAccessKey: string): Promise<CheckContext> {
  const [issued, purchaseOrders, suppliers, products, postedInvoices, payments, receipts] = await Promise.all([
    deps.sefaz.listIssuedInvoices(),
    deps.purchasing.listPurchaseOrders(),
    deps.registry.listSuppliers(),
    deps.registry.listProducts(),
    deps.payables.listPostedInvoices(),
    deps.bank.listPayments(),
    deps.wms.listReceipts(),
  ]);
  const capturedInvoices = issued.filter((i) => i.accessKey !== invoiceAccessKey);
  return { purchaseOrders, suppliers, products, postedInvoices, payments, receipts, capturedInvoices };
}
