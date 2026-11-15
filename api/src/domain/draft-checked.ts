import { draftProposal, type Draft } from './approval.js';
import { amountAtRiskItemTrocado } from './checks/e2-item-trocado.js';
import { isShortLine, proposeE3 } from './checks/e3-quantidade-menor.js';
import { e4AmountAtRisk } from './checks/e4-unidade-de-medida.js';
import type { Classification } from './classification.js';
import type { CheckContext } from './context.js';
import { DockAction, type PartialLine } from './dock-action.js';
import type { Invoice, InvoiceItem } from './invoice.js';
import { Money } from './money.js';
import { Quantity } from './quantity.js';
import { amountAtRiskOfMissing, assessCount, missingItems } from './reconciliation.js';

/** #56: o que uma divergência pede na proposta: as linhas a segurar ou devolver e o valor em risco. */
type Part = { readonly lines: readonly PartialLine[]; readonly risk: Money; readonly why: string };

const NONE: Part = { lines: [], risk: Money.zero(), why: '' };

/** #56: a linha da doca precisa do SKU da nota e da unidade do item (o título reduz por elas, #63). */
function itemBySku(invoice: Invoice, sku: string): InvoiceItem | undefined {
  return invoice.items.find((i) => i.sku !== null && i.sku === sku);
}

/** #56 E1 (#69): segura os itens que não aparecem na contagem; valor em risco pelo amountAtRiskOfMissing. */
function partE1(invoice: Invoice, ctx: CheckContext): Part {
  const assessment = assessCount(invoice, ctx);
  if (assessment.status === 'no_count') return NONE;
  const missing = missingItems(invoice, assessment.lines);
  const lines = missing
    .filter(({ item }) => item.sku !== null)
    .map(({ item }) => ({ sku: item.sku as string, quantity: item.quantity, disposition: 'segurar' as const }));
  const risk = amountAtRiskOfMissing(invoice, assessment.lines).amount;
  return { lines, risk, why: `E1: ${missing.length} item(ns) não aparecem na contagem, segurados` };
}

/** #56 E3 (#73): a proposta do proposeE3, com a diferença a devolver na unidade do item da nota. */
function partE3(invoice: Invoice, ctx: CheckContext): Part {
  const assessment = assessCount(invoice, ctx);
  if (assessment.status === 'no_count' || !assessment.lines.some(isShortLine)) return NONE;
  const props = proposeE3(invoice, ctx, assessment.lines);
  const proposed = props.dockAction.kind === 'receber_parcial' ? props.dockAction.lines : [];
  const lines: PartialLine[] = [];
  for (const line of proposed) {
    const item = itemBySku(invoice, line.sku);
    if (!item) continue;
    const factor =
      item.quantity.unit === line.quantity.unit
        ? 1
        : (ctx.products.find((p) => p.sku === item.sku)?.boxFactor ?? 0);
    if (factor <= 0) continue;
    lines.push({ ...line, quantity: Quantity.of(line.quantity.amount / factor, item.quantity.unit) });
  }
  return { lines, risk: props.amountAtRisk.amount, why: props.justification };
}

/** #56 E2 (#70): segura o item trocado; valor em risco igual ao valor dele (amountAtRiskItemTrocado). */
function partE2(invoice: Invoice, ctx: CheckContext): Part {
  const skus = new Set(invoice.divergences.filter((d) => d.classification === 'E2').flatMap((d) => d.skus));
  const lines = invoice.items
    .filter((i) => i.sku !== null && skus.has(i.sku))
    .map((i) => ({ sku: i.sku as string, quantity: i.quantity, disposition: 'segurar' as const }));
  return { lines, risk: amountAtRiskItemTrocado(invoice, ctx).amount, why: 'E2: item trocado segurado' };
}

/** #56 E4 (#67): recebe; o valor em risco é o que a verificação do E4 calcula. */
function partE4(invoice: Invoice, ctx: CheckContext): Part {
  return { lines: [], risk: e4AmountAtRisk(invoice, ctx).amount, why: 'E4: caixa cobrada como unidade; recebe' };
}

function partOf(code: Classification, invoice: Invoice, ctx: CheckContext, overcharge: Money | null): Part {
  if (code === 'E1') return partE1(invoice, ctx);
  if (code === 'E2') return partE2(invoice, ctx);
  if (code === 'E3') return partE3(invoice, ctx);
  if (code === 'E4') return partE4(invoice, ctx);
  if (code === 'NAO_CATALOGADA' && overcharge) {
    return { lines: [], risk: overcharge, why: `Diferença de preço: ${overcharge.toString()} acima da ordem` };
  }
  // #56: o E8 (#66) entra quando o amountAtRiskOfUnregistered do #112 chegar à main.
  return NONE;
}

/** #56: o mesmo SKU em mais de uma divergência fica com a maior quantidade, sem passar a da nota. */
function mergeLines(invoice: Invoice, parts: readonly Part[]): PartialLine[] {
  const bySku = new Map<string, PartialLine>();
  for (const line of parts.flatMap((p) => p.lines)) {
    const current = bySku.get(line.sku);
    if (!current || current.quantity.amount < line.quantity.amount) bySku.set(line.sku, line);
  }
  return [...bySku.values()].map((line) => {
    const item = itemBySku(invoice, line.sku);
    return item && line.quantity.amount > item.quantity.amount ? { ...line, quantity: item.quantity } : line;
  });
}

/** #56: a ação mais restritiva. Segurar a nota inteira é recusar; sem linha, receber. */
function actionOf(invoice: Invoice, lines: readonly PartialLine[]): DockAction {
  if (lines.length === 0) return DockAction.receive();
  const allHeld = invoice.items.every((i) =>
    lines.some((l) => l.sku === i.sku && l.quantity.amount >= i.quantity.amount),
  );
  return allHeld ? DockAction.refuse() : DockAction.partial(lines);
}

/**
 * #56: a proposta da nota conferida, ligando cada exceção ao que a história dela construiu. E6, E7 e
 * match seguem o `draftProposal` (#63, #64). Com várias divergências, o valor em risco é a soma,
 * limitada ao valor da nota (regra 6), e a ação é a mais restritiva.
 */
export function draftChecked(invoice: Invoice, ctx: CheckContext, overcharge: Money | null): Draft {
  const codes = [...new Set(invoice.divergences.map((d) => d.classification))];
  if (codes.length === 0 || codes.includes('E6') || codes.includes('E7')) {
    return draftProposal(invoice, overcharge);
  }
  const parts = codes.map((code) => partOf(code, invoice, ctx, overcharge));
  const sum = parts.reduce((acc, p) => acc.add(p.risk), Money.zero());
  const risk = sum.compare(invoice.total) > 0 ? invoice.total : sum;
  const why = parts.map((p) => p.why).filter((w) => w !== '');
  return {
    dockAction: actionOf(invoice, mergeLines(invoice, parts)),
    amountAtRisk: risk,
    justification:
      why.length > 0 ? why.join('; ') : `Divergência ${invoice.classification}: a ação e o valor ficam com quem aprova`,
  };
}
