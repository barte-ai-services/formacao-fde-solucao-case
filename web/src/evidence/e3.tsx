import { Panel, ReconciliationDiff, type ComparisonField } from "@barte-ai-services/barte-ui-kit";
import type { EvidenceDto } from "../api/contract";
import { GenericEvidence } from "./GenericEvidence";
import { registerEvidence, type EvidenceProps } from "./registry";

/** #73: uma linha a menos, como a evidência do WMS do checkQuantidadeMenor a descreve. */
interface ShortItem {
  description: string;
  counted: number;
  invoiced: number;
  unit: string;
}

/** #73: "Contado 75 UN de 100 UN: Óleo de soja 900 ml". Quantidades inteiras, na mesma unidade. */
const COUNT = /^Contado (\d+) (UN|CX) de (\d+) (UN|CX): (.+)$/;

/** #73: a linha da evidência do WMS, ou null quando ela não segue o formato do checkQuantidadeMenor. */
function parseShort(evidence: EvidenceDto): ShortItem | null {
  const match = COUNT.exec(typeof evidence.description === "string" ? evidence.description : "");
  if (!match) return null;
  const [, counted = "", unit = "", invoiced = "", invoicedUnit = "", description = ""] = match;
  const item = { description, counted: Number(counted), invoiced: Number(invoiced), unit };
  if (unit !== invoicedUnit || !(item.counted > 0 && item.counted < item.invoiced)) return null;
  return item;
}

/** #73: todas as linhas do WMS, ou null se alguma não segue o formato: nenhum item some da tela. */
function parseAll(evidence: readonly EvidenceDto[]): ShortItem[] | null {
  const counts = evidence.filter((e) => e?.source === "wms");
  const items = counts.map(parseShort);
  if (items.length === 0 || items.some((i) => i === null)) return null;
  return items as ShortItem[];
}

/**
 * E3 · Quantidade menor. #73/AC-1 e AC-2: por item, o contado na doca contra o cobrado na nota, com o
 * que volta na nota de devolução, e a ordem de compra. A diferença aparece em quantidade: a evidência
 * do E3 não traz dinheiro (o valor em risco está na proposta, #73). Fora do formato, cai no genérico.
 */
function QuantidadeMenorEvidence({ divergence }: EvidenceProps) {
  const evidence = Array.isArray(divergence.evidence) ? divergence.evidence : [];
  const count = evidence.find((e) => e?.source === "wms");
  const order = evidence.find((e) => e?.source === "erp_compras");
  const items = parseAll(evidence);
  if (!count || !items) return <GenericEvidence divergence={divergence} />;

  const fields: ComparisonField[] = [
    ...items.map<ComparisonField>((item, index) => ({
      key: `item-${index}-${item.description}`,
      label: item.description,
      a: `${item.counted} ${item.unit} recebidas`,
      b: `${item.invoiced} ${item.unit} cobradas`,
      state: "divergent",
      note: `devolver ${item.invoiced - item.counted} ${item.unit}`,
    })),
    order
      ? { key: "ordem", label: "Ordem de compra", a: order.reference, b: order.reference, state: "match" }
      : { key: "ordem", label: "Ordem de compra", a: null, b: "sem ordem citada", state: "missing" },
  ];

  return (
    <Panel
      title={divergence.exceptionName}
      description={`Evidência: recebimento ${count.reference}`}
      size="sm"
      padding="md"
    >
      <ReconciliationDiff
        columns={["Contagem na doca", "Nota fiscal"]}
        fields={fields}
        showSummary
        variant="grid"
        ariaLabel="Contagem contra nota"
      />
    </Panel>
  );
}

registerEvidence("E3", QuantidadeMenorEvidence);
