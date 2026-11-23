// Captura do Cron: lê a SEFAZ, grava as notas novas e confere as que estão a conferir (#59, AC-5).
import { descriptionMatchRequests } from '../domain/checks/e8-item-sem-cadastro.js';
import { withDescriptionMatches, type CheckContext, type DescriptionSuggester, type Invoice } from '../domain/index.js';
import type { CheckFailure, InvoiceStore } from '../connectors/invoice-store.js';
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
  /** #35 O Claude, que sugere o casamento por descrição na rodada. Sem ele, a regra decide sozinha. */
  readonly descriptions?: DescriptionSuggester;
  /** #362 As sugestões lidas só quando há nota a conferir: a rodada quieta não paga a leitura. Vale se `descriptions` não vier. */
  readonly loadDescriptions?: () => Promise<DescriptionSuggester | undefined>;
};

export type CaptureResult = {
  /** #59 Notas que a SEFAZ devolveu. */
  readonly seen: number;
  /** #59 Notas novas gravadas nesta rodada (regra 1: a chave repetida não entra de novo). */
  readonly inserted: number;
  /** #59 Notas conferidas nesta rodada. */
  readonly checked: number;
  /** #56 Notas que quebraram na conferência e ficaram a conferir, marcadas com o motivo. */
  readonly failed: number;
  /** #356 AC-4 As notas que quebraram, com o motivo: só vem quando a captura não as marcou (`markFailures: false`). */
  readonly failures?: readonly CheckFailure[];
};

export type CaptureOptions = {
  /**
   * #356 AC-4 Marcar as notas que quebraram dentro da captura (padrão), um update por nota. A rodada orçada passa `false`: a captura
   * é o passo crítico e o laço de updates não tem teto; as marcas viram o passo próprio da rodada (`markCheckFailures`).
   */
  readonly markFailures?: boolean;
};

/**
 * #59 Idempotente: a segunda rodada sobre a mesma SEFAZ não grava nem confere nada de novo.
 * #362 Em lote: duas leituras (as chaves da SEFAZ e as notas guardadas) dizem o que é novo e o que falta conferir. Sem nenhuma das duas
 * a captura termina ali, e o gasto não depende de quantas notas há. Com trabalho, lê as notas e os itens (uma vez, para todas), grava só
 * as novas e confere só as novas e as a conferir; a conferência vê todas as notas capturadas, como sempre (a E6 compara com elas).
 * #362 AC-3 "Mudada" é a nota guardada que ainda está `a_conferir`: o conteúdo de uma NF-e não muda sob a mesma chave de acesso (a
 * correção é outra nota ou uma carta de correção), então a nota já conferida não se confere de novo, como já era antes do lote.
 */
export async function captureInvoices(deps: CaptureDeps, options: CaptureOptions = {}): Promise<CaptureResult> {
  const [issuedKeys, stored] = await Promise.all([deps.sefaz.listIssuedKeys(), deps.invoices.listStored()]);
  const known = new Set(stored.map((s) => s.accessKey));
  const issuedSet = new Set(issuedKeys);
  const pending = new Map(stored.filter((s) => s.state === 'a_conferir' && issuedSet.has(s.accessKey)).map((s) => [s.accessKey, s.checkError]));
  const fresh = issuedKeys.filter((key) => !known.has(key));
  if (fresh.length === 0 && pending.size === 0) return { seen: issuedKeys.length, inserted: 0, checked: 0, failed: 0 };
  const issued = await deps.sefaz.listIssuedInvoices();
  const freshSet = new Set(fresh);
  const inserted = await deps.invoices.insertNew(issued.filter((i) => freshSet.has(i.accessKey)));
  for (const key of inserted) pending.set(key, null);
  const toCheck = issued.filter((i) => pending.has(i.accessKey));
  if (toCheck.length === 0) return { seen: issued.length, inserted: inserted.length, checked: 0, failed: 0 };
  const ctx = await buildContext(deps, issued);
  // #66 Com as sugestões do Claude, a conferência roda dentro da rodada, e o cache se limpa no fim.
  const descriptions = deps.descriptions ?? (await deps.loadDescriptions?.());
  const { checked, failures } = descriptions
    ? await withDescriptionMatches(
        descriptions,
        toCheck.flatMap((invoice) => descriptionMatchRequests(invoice, ctx)),
        () => checkEach(toCheck, ctx, pending),
      )
    : checkEach(toCheck, ctx, pending);
  await deps.invoices.saveChecked(checked, (deps.now ?? (() => new Date()))().toISOString());
  const counts = { seen: issued.length, inserted: inserted.length, checked: checked.length, failed: failures.length };
  if (options.markFailures === false) return { ...counts, failures };
  await deps.invoices.markCheckFailed(notYetMarked(failures));
  return counts;
}

/** #356 AC-4 Tira as notas que já guardam este mesmo motivo: marcá-las de novo é um update que não muda nada. */
function notYetMarked(failures: readonly CheckFailure[]): CheckFailure[] {
  return failures.filter((f) => f.storedReason !== f.reason);
}

/**
 * #356 AC-4 Marca as notas que quebraram na conferência, até `limit` por chamada: um update por nota. O corte do teto vem
 * DEPOIS de tirar as que já guardam o mesmo motivo (o motivo guardado veio na leitura das pendentes, sem subrequest a mais);
 * sem isso as mesmas primeiras notas gastariam o teto toda rodada e as de trás nunca seriam marcadas. A nota fora do teto
 * segue a conferir, e a rodada seguinte a confere de novo e a marca.
 */
export async function markCheckFailures(
  deps: Pick<CaptureDeps, 'invoices'>,
  failures: readonly CheckFailure[],
  limit: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  await deps.invoices.markCheckFailed(notYetMarked(failures).slice(0, limit));
}

/** #56 Confere nota a nota: a que quebra fica de fora, com o motivo, e não derruba as outras. */
function checkEach(
  invoices: readonly Invoice[],
  ctx: CheckContext,
  stored: ReadonlyMap<string, string | null>,
): { checked: Invoice[]; failures: CheckFailure[] } {
  const checked: Invoice[] = [];
  const failures: CheckFailure[] = [];
  for (const invoice of invoices) {
    try {
      // #59 Regra 1: a nota não é duplicada de si mesma; a E6 compara com as outras capturadas.
      invoice.check({ ...ctx, capturedInvoices: ctx.capturedInvoices.filter((o) => o.accessKey !== invoice.accessKey) });
      checked.push(invoice);
    } catch (error) {
      failures.push({
        accessKey: invoice.accessKey,
        reason: error instanceof Error ? error.message : String(error),
        storedReason: stored.get(invoice.accessKey) ?? null,
      });
    }
  }
  return { checked, failures };
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
