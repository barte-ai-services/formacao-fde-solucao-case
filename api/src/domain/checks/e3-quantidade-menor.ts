import { AmountAtRisk } from '../amount-at-risk.js';
import type { ApprovalLevel } from '../approval-level.js';
import type { CheckContext, PurchaseOrder, Receipt } from '../context.js';
import { Divergence } from '../divergence.js';
import { DockAction } from '../dock-action.js';
import { DomainError } from '../errors.js';
import type { Evidence } from '../evidence.js';
import type { InvoiceItem, InvoiceView } from '../invoice.js';
import { Money } from '../money.js';
import type { Proposal, ProposalProps } from '../proposal.js';
import type { Quantity } from '../quantity.js';
import { reconcile, type ReconciliationLine } from '../reconciliation.js';
import type { Title } from '../title.js';
import type { Check } from './check.js';

type Reconcile = typeof reconcile;

// temporário até o #84: troca por findReceipt/orderOf/countRoute
/** Recebimento da nota pela chave de acesso. Recebimento sem chave (nula) nunca casa. */
function receiptOf(invoice: InvoiceView, receipts: readonly Receipt[]): Receipt | undefined {
  return receipts.find((r) => r.invoiceAccessKey !== null && r.invoiceAccessKey === invoice.accessKey);
}

// temporário até o #84: troca por findReceipt/orderOf/countRoute
/** Ordem que a nota cobra, pelo número referenciado. */
function orderOf(invoice: InvoiceView, orders: readonly PurchaseOrder[]): PurchaseOrder | undefined {
  return invoice.purchaseOrderRef === null ? undefined : orders.find((o) => o.id === invoice.purchaseOrderRef);
}

const CEM_MIL = Money.ofCents(10_000_000);
const VINTE_MIL = Money.ofCents(2_000_000);

// temporário até o #84: troca por findReceipt/orderOf/countRoute
/**
 * Nível de aprovação do E3 pela tabela de limites (docs/domain/README.md). A `ApprovalPolicy` é do
 * plano #63; até lá, só as linhas que valem para o E3: linha 2 (nota acima de R$ 100 mil ou
 * fornecedor com pagamento bloqueado → diretoria), linha 4 (acima de R$ 20 mil → coordenação),
 * linha 5 (até R$ 20 mil → analista).
 */
function levelOf(invoice: InvoiceView, ctx: CheckContext): ApprovalLevel {
  const blocked = ctx.suppliers.find((s) => s.id === invoice.supplierId)?.paymentBlocked ?? false;
  if (blocked || invoice.total.compare(CEM_MIL) > 0) return 'diretoria';
  if (invoice.total.compare(VINTE_MIL) > 0) return 'coordenacao';
  return 'analista';
}

/** Linha que chegou a menos: mesma unidade, contado acima de zero e abaixo do faturado. Zero é E1. */
export function isShortLine(line: ReconciliationLine): boolean {
  if (line.counted.unit !== line.invoiced.unit) return false;
  return line.counted.amount > 0 && line.counted.isLessThan(line.invoiced);
}

function itemOf(invoice: InvoiceView, line: ReconciliationLine): InvoiceItem | undefined {
  return invoice.items.find((i) => i.supplierCode === line.supplierCode && i.sku === line.sku);
}

const skuOf = (line: ReconciliationLine): string => line.sku ?? line.supplierCode;

const fmt = (q: Quantity): string => `${q.amount} ${q.unit}`;

/**
 * E3 — quantidade menor: chegou menos do que a nota cobra (contado acima de zero e abaixo do
 * faturado, na mesma unidade, depois da conciliação em UN). Contado zero é falta física (E1).
 * Regra que rege: regras 4 e 6.
 * Dona: plano #73 (história #45).
 *
 * A conciliação entra por parâmetro para os testes; a verificação publicada usa `reconcile`.
 */
export function makeCheckQuantidadeMenor(reconcileFn: Reconcile = reconcile): Check {
  return (invoice, ctx) => {
    const receipt = receiptOf(invoice, ctx.receipts);
    if (receipt === undefined) return [];
    const short = reconcileFn(invoice, receipt, ctx.products).filter(isShortLine);
    if (short.length === 0) return [];
    const evidence: Evidence[] = short.map((line) => ({
      source: 'wms',
      reference: receipt.id,
      description: `Contado ${fmt(line.counted)} de ${line.invoiced.amount} ${line.invoiced.unit}: ${
        itemOf(invoice, line)?.description ?? line.supplierCode
      }`,
    }));
    const order = orderOf(invoice, ctx.purchaseOrders);
    if (order !== undefined) {
      evidence.push({ source: 'erp_compras', reference: order.id, description: `Ordem cobrada pela nota ${invoice.number}` });
    }
    return [Divergence.of({ classification: 'E3', skus: short.map(skuOf), evidence })];
  };
}

export const checkQuantidadeMenor: Check = makeCheckQuantidadeMenor(reconcile); // ADR-002

/** Regra 6: o valor em risco é a diferença em dinheiro: o valor do item proporcional ao que faltou. */
export function amountAtRiskOfShortfall(invoice: InvoiceView, lines: readonly ReconciliationLine[]): AmountAtRisk {
  const cents = lines.filter(isShortLine).reduce((sum, line) => {
    const item = itemOf(invoice, line);
    if (item === undefined) return sum;
    return sum + Math.round((item.total.cents * line.missing.amount) / line.invoiced.amount);
  }, 0);
  return AmountAtRisk.of(Money.ofCents(cents), invoice.total);
}

/**
 * #45/AC-2: a proposta do E3 é receber parcial, devolvendo o que faltou, com valor em risco igual à
 * diferença. Devolve as props; quem registra (`Proposal.register`) é quem chama.
 */
export function proposeQuantidadeMenor(
  invoice: InvoiceView,
  ctx: CheckContext,
  lines: readonly ReconciliationLine[],
): ProposalProps {
  const short = lines.filter(isShortLine);
  if (short.length === 0) throw new DomainError('E3: sem linha a menos, não há proposta de quantidade menor');
  const counts = short.map((l) => `${skuOf(l)} contado ${fmt(l.counted)} de ${fmt(l.invoiced)}`).join('; ');
  return {
    classification: 'E3',
    dockAction: DockAction.partial(
      short.map((l) => ({ sku: skuOf(l), quantity: l.missing, disposition: 'devolver' as const })),
    ),
    level: levelOf(invoice, ctx),
    amountAtRisk: amountAtRiskOfShortfall(invoice, short),
    justification: `Chegou menos do que a nota ${invoice.number} cobra (${counts}). Receber o contado e devolver a diferença.`,
  };
}

/** A nota de devolução da diferença. Mesma forma do `ReturnNoteMessage` da caixa de saída do ERP. */
export type ReturnNote = {
  readonly invoiceAccessKey: string;
  readonly lines: readonly { readonly supplierCode: string; readonly quantity: Quantity }[];
  readonly reason: string;
};

/**
 * #45/AC-3 e AC-4: liquida a proposta aprovada do E3. Reduz o título ao valor recebido (o atual
 * menos o valor em risco) e devolve a nota de devolução da diferença, para a caixa de saída.
 * Só a proposta `aprovada`: a `alterada` trocou a ação na doca e não é liquidada por aqui (lança
 * DomainError), assim como qualquer outro estado.
 */
export function settleQuantidadeMenor(
  proposal: Proposal,
  title: Title,
  invoice: InvoiceView,
  lines: readonly ReconciliationLine[],
): ReturnNote {
  if (proposal.classification !== 'E3') {
    throw new DomainError(`E3: a proposta é ${proposal.classification}, não E3`);
  }
  if (proposal.state !== 'aprovada') {
    throw new DomainError(`E3: só a proposta aprovada é liquidada, esta está "${proposal.state}"`);
  }
  if (title.invoiceAccessKey !== invoice.accessKey) {
    throw new DomainError('E3: o título não é da nota');
  }
  const short = lines.filter(isShortLine);
  if (short.length === 0) throw new DomainError('E3: sem linha a menos para devolver');
  title.reduce(title.amount.subtract(proposal.amountAtRisk.amount));
  return {
    invoiceAccessKey: invoice.accessKey,
    lines: short.map((l) => ({ supplierCode: l.supplierCode, quantity: l.missing })),
    reason: `E3 quantidade menor na nota ${invoice.number}: devolução da diferença`,
  };
}
