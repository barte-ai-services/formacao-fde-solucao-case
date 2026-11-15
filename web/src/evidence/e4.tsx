import { Block, DataList, Panel, ReconciliationDiff, type ComparisonField } from "@barte-ai-services/barte-ui-kit";
import type { Unit } from "../api/contract";
import { GenericEvidence } from "./GenericEvidence";
import { divergenceLabel } from "./labels";
import { registerEvidence, type EvidenceProps } from "./registry";

interface Side {
  quantity: number;
  unit: Unit;
  price: string;
}

/** #37: o que a evidência da E4 diz de um SKU, já lido do fio. */
interface SkuConversion {
  sku: string;
  order: string;
  invoice: Side;
  ordered: Side;
  factor: number;
}

/**
 * #37: os três textos que `api/src/domain/checks/e4-unidade-de-medida.ts` escreve por SKU. O preço
 * vem do `Money.toString()` do domínio e só é mostrado, nunca recalculado.
 */
const PRICE = String.raw`-?R\$ \d{1,3}(?:\.\d{3})*,\d{2}`;
const ON_INVOICE = new RegExp(String.raw`^Item (\S+) na nota: (\d+) (UN|CX) a (${PRICE})$`);
const ON_ORDER = new RegExp(String.raw`^Item (\S+) na ordem: (\d+) (UN|CX) a (${PRICE})$`);
const IN_REGISTRY = /^Produto (\S+): fator de caixa (\d+); nota (\d+) UN, ordem (\d+) UN$/;

/** #37: um campo de texto de um registro do fio, que pode trazer qualquer coisa. */
function textField(item: unknown, field: "source" | "reference" | "description"): string {
  if (typeof item !== "object" || item === null || !Object.hasOwn(item, field)) return "";
  const value: unknown = Reflect.get(item, field);
  return typeof value === "string" ? value : "";
}

function parseInteger(digits: string | undefined): number | undefined {
  if (digits === undefined) return undefined;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : undefined;
}

function parseUnit(code: string | undefined): Unit | undefined {
  return code === "UN" || code === "CX" ? code : undefined;
}

function parseSide(m: RegExpExecArray): Side | undefined {
  const quantity = parseInteger(m[2]);
  const unit = parseUnit(m[3]);
  const price = m[4];
  return quantity === undefined || unit === undefined || price === undefined ? undefined : { quantity, unit, price };
}

/** #37: a quantidade em UN, pela conta com o fator do cadastro. */
function toUnits(side: Side, factor: number): number {
  return side.unit === "CX" ? side.quantity * factor : side.quantity;
}

interface PartialConversion {
  invoice?: Side;
  ordered?: Side;
  order?: string;
  registry?: { factor: number; invoiceUnits: number; orderUnits: number };
}

/**
 * #37: agrupa as evidências por SKU e monta a conversão de cada um. Qualquer evidência que não se
 * leia, SKU sem as três, unidades iguais ou fator que não fecha com as quantidades do cadastro
 * devolvem `undefined`, e a tela cai no genérico em vez de mostrar uma conta pela metade.
 */
function parseConversions(evidence: unknown): SkuConversion[] | undefined {
  if (!Array.isArray(evidence) || evidence.length === 0) return undefined;
  const records: readonly unknown[] = evidence;
  const bySku = new Map<string, PartialConversion>();
  const forSku = (sku: string | undefined): PartialConversion | undefined => {
    if (sku === undefined) return undefined;
    const current = bySku.get(sku) ?? {};
    bySku.set(sku, current);
    return current;
  };
  for (const item of records) {
    const source = textField(item, "source");
    const description = textField(item, "description");
    const reference = textField(item, "reference");
    const invoiceMatch = source === "sefaz" ? ON_INVOICE.exec(description) : null;
    const orderMatch = source === "erp_compras" ? ON_ORDER.exec(description) : null;
    const registryMatch = source === "erp_cadastro" ? IN_REGISTRY.exec(description) : null;
    if (invoiceMatch !== null) {
      const partial = forSku(invoiceMatch[1]);
      const side = parseSide(invoiceMatch);
      if (partial === undefined || side === undefined || partial.invoice !== undefined) return undefined;
      partial.invoice = side;
    } else if (orderMatch !== null) {
      const partial = forSku(orderMatch[1]);
      const side = parseSide(orderMatch);
      if (partial === undefined || side === undefined || partial.ordered !== undefined || reference === "") return undefined;
      partial.ordered = side;
      partial.order = reference;
    } else if (registryMatch !== null) {
      const partial = forSku(registryMatch[1]);
      const factor = parseInteger(registryMatch[2]);
      const invoiceUnits = parseInteger(registryMatch[3]);
      const orderUnits = parseInteger(registryMatch[4]);
      if (
        partial === undefined ||
        factor === undefined ||
        invoiceUnits === undefined ||
        orderUnits === undefined ||
        partial.registry !== undefined
      ) {
        return undefined;
      }
      partial.registry = { factor, invoiceUnits, orderUnits };
    } else {
      return undefined;
    }
  }
  const conversions: SkuConversion[] = [];
  for (const [sku, { invoice, ordered, order, registry }] of bySku) {
    if (invoice === undefined || ordered === undefined || order === undefined || registry === undefined) return undefined;
    if (invoice.unit === ordered.unit || registry.factor <= 0) return undefined;
    if (toUnits(invoice, registry.factor) !== registry.invoiceUnits) return undefined;
    if (toUnits(ordered, registry.factor) !== registry.orderUnits) return undefined;
    conversions.push({ sku, order, invoice, ordered, factor: registry.factor });
  }
  return conversions;
}

function formatQuantity(side: Side): string {
  return `${side.quantity} ${side.unit}`;
}

/** #37: o lado em CX mostra a conta; o lado em UN, a quantidade como veio. */
function converted(side: Side, factor: number): string {
  return side.unit === "CX" ? `${formatQuantity(side)} × fator ${factor} = ${toUnits(side, factor)} UN` : formatQuantity(side);
}

function fields(c: SkuConversion): ComparisonField[] {
  const matches = toUnits(c.invoice, c.factor) === toUnits(c.ordered, c.factor);
  return [
    {
      label: "Quantidade",
      a: formatQuantity(c.invoice),
      b: formatQuantity(c.ordered),
      state: "not-comparable",
      note: "unidades diferentes; a comparação é depois da conversão",
    },
    {
      label: "Convertido",
      a: converted(c.invoice, c.factor),
      b: converted(c.ordered, c.factor),
      state: matches ? "match" : "divergent",
    },
    {
      label: "Preço",
      a: `${c.invoice.price} por ${c.invoice.unit}`,
      b: `${c.ordered.price} por ${c.ordered.unit}`,
      state: "not-comparable",
      note: `preço por ${c.invoice.unit} contra preço por ${c.ordered.unit}`,
    },
  ];
}

/** #37: o fator que as quantidades da nota e da ordem sugerem, ao lado do que o cadastro tem. */
function factorToFix(c: SkuConversion): string {
  const boxes = c.invoice.unit === "CX" ? c.invoice : c.ordered;
  const units = c.invoice.unit === "CX" ? c.ordered : c.invoice;
  const observed =
    boxes.quantity > 0 && units.quantity % boxes.quantity === 0
      ? `1 CX = ${units.quantity / boxes.quantity} UN`
      : `${formatQuantity(boxes)} para ${formatQuantity(units)}, não fecha em caixa inteira`;
  return `Cadastro: 1 CX = ${c.factor} UN · observado: ${observed}`;
}

/**
 * E4 · Unidade de medida, #37. Por SKU, a quantidade da nota contra a da ordem, a conversão pelo
 * fator do cadastro e o preço em cada unidade, e o fator a corrigir no Cadastro. O que não se lê
 * cai no genérico.
 */
export function UnidadeDeMedidaEvidence({ divergence }: EvidenceProps) {
  const conversions = parseConversions(divergence.evidence);
  if (conversions === undefined || conversions.length === 0) return <GenericEvidence divergence={divergence} />;
  const orders = [...new Set(conversions.map((c) => c.order))].join(", ");
  return (
    <Panel
      title={divergenceLabel(String(divergence.classification))}
      description={`Evidência: Ordem ${orders} e cadastro do produto`}
      size="sm"
      padding="md"
    >
      {conversions.map((c) => (
        <ReconciliationDiff
          key={c.sku}
          ariaLabel={`Conversão do ${c.sku}`}
          fieldLabel={c.sku}
          columns={["Nota fiscal", "Ordem de compra"]}
          fields={fields(c)}
          showSummary={false}
          variant="grid"
        />
      ))}
      {/* #37: fica mesmo quando o fator confere, porque o domínio (#88) publica a correção de toda E4 aprovada. */}
      <Block title="Fator a corrigir no Cadastro" size="overline" headingLevel={4}>
        <DataList
          divided
          aria-label="Fator a corrigir no Cadastro"
          items={conversions.map((c) => ({ key: c.sku, label: c.sku, value: factorToFix(c), emphasis: true }))}
        />
      </Block>
    </Panel>
  );
}

registerEvidence("E4", UnidadeDeMedidaEvidence);
