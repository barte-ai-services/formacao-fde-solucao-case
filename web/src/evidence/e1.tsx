import { Panel, ReconciliationDiff, type ComparisonField } from "@barte-ai-services/barte-ui-kit";
import type { EvidenceDto } from "../api/contract";
import { GenericEvidence } from "./GenericEvidence";
import { divergenceLabel } from "./labels";
import { registerEvidence, type EvidenceProps } from "./registry";

/** #44: um item que não aparece na contagem, como a evidência do WMS o descreve (#69). */
interface MissingItem {
  description: string;
  quantity: string;
  value: string;
  cents: number;
}

const BRL = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COUNT_PREFIX = "Não aparece na contagem: ";
const ITEM = /^(.+) \((\d+(?:,\d+)?) (UN|CX), (R\$ [\d.]+,\d{2})\)$/;

/** #44: "R$ 28.655,20" em centavos inteiros. */
function toCents(value: string): number {
  return Number(value.replace(/[^\d]/g, ""));
}

/** #44: os itens da evidência do WMS, ou null quando ela não segue o formato do checkFaltaFisica (#69). */
function parseMissing(evidence: EvidenceDto | undefined): MissingItem[] | null {
  if (!evidence || typeof evidence.description !== "string" || !evidence.description.startsWith(COUNT_PREFIX)) {
    return null;
  }
  const items: MissingItem[] = [];
  for (const part of evidence.description.slice(COUNT_PREFIX.length).split("; ")) {
    const match = ITEM.exec(part);
    if (!match) return null;
    const [, description = "", amount = "", unit = "", value = ""] = match;
    items.push({ description, quantity: `${amount} ${unit}`, value, cents: toCents(value) });
  }
  return items.length > 0 ? items : null;
}

/**
 * E1 · Falta física. #44/AC-2 a AC-4: por item, o contado na doca contra o cobrado na nota e o pedido
 * da ordem, com o valor em risco somado. A evidência que não segue o formato do #69 cai no genérico.
 */
function FaltaFisicaEvidence({ divergence }: EvidenceProps) {
  const evidence = Array.isArray(divergence.evidence) ? divergence.evidence : [];
  const count = evidence.find((e) => e?.source === "wms");
  const order = evidence.find((e) => e?.source === "erp_compras");
  const missing = parseMissing(count);
  if (!count || !missing) return <GenericEvidence divergence={divergence} />;

  const risk = missing.reduce((sum, item) => sum + item.cents, 0);
  const fields: ComparisonField[] = [
    ...missing.map<ComparisonField>((item) => ({
      key: `item-${item.description}`,
      label: item.description,
      a: "não contado",
      b: `${item.quantity} · ${item.value}`,
      state: "divergent",
      note: order ? `pedido na ordem ${order.reference}` : undefined,
    })),
    order
      ? { key: "ordem", label: "Ordem de compra", a: order.reference, b: order.reference, state: "match" }
      : { key: "ordem", label: "Ordem de compra", a: null, b: "sem ordem citada", state: "missing" },
    { key: "risco", label: "Valor em risco", a: null, b: `R$ ${BRL.format(risk / 100)}`, state: "divergent" },
  ];

  return (
    <Panel
      title={divergenceLabel("E1")}
      description={`Evidência: recebimento ${count.reference}`}
      size="sm"
      padding="md"
    >
      <ReconciliationDiff
        columns={["Contagem na doca", "Nota fiscal"]}
        fields={fields}
        showSummary
        variant="grid"
        ariaLabel="Contagem contra nota e pedido"
      />
    </Panel>
  );
}

registerEvidence("E1", FaltaFisicaEvidence);
