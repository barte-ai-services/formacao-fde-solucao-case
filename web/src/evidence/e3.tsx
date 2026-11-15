import { DataList, Panel, ReconciliationDiff, type ComparisonField } from "@barte-ai-services/barte-ui-kit";
import { GenericEvidence } from "./GenericEvidence";
import { divergenceLabel, sourceLabel } from "./labels";
import { registerEvidence, type EvidenceProps } from "./registry";

/** #73: o texto que o E3 grava na evidência do WMS, "Contado 75 UN de 100 UN: Óleo de soja 900 ml". */
const COUNT = /^Contado (\d+(?:[.,]\d+)?) (UN|CX) de (\d+(?:[.,]\d+)?) (UN|CX): (.+)$/;

type Count = { counted: number; invoiced: number; unit: string; item: string };

function parseCount(description: unknown): Count | null {
  const match = COUNT.exec(String(description ?? ""));
  if (!match || match[2] !== match[4]) return null;
  const counted = Number(match[1]!.replace(",", "."));
  const invoiced = Number(match[3]!.replace(",", "."));
  if (!(counted > 0 && counted < invoiced)) return null;
  return { counted, invoiced, unit: match[2]!, item: match[5]! };
}

/**
 * E3 · Quantidade menor (#73, wireframe F3): o contado no recebimento contra o cobrado na nota, item
 * a item, com o que volta na nota de devolução. Sem a contagem no formato esperado, cai no genérico.
 */
function QuantidadeMenorEvidence({ divergence }: EvidenceProps) {
  const evidence = Array.isArray(divergence.evidence) ? divergence.evidence : [];
  const counts = evidence
    .filter((e) => e?.source === "wms")
    .map((e) => parseCount(e?.description))
    .filter((c): c is Count => c !== null);
  if (counts.length === 0) return <GenericEvidence divergence={divergence} />;

  const fields: ComparisonField[] = counts.flatMap((c, i) => [
    { key: `item-${i}`, label: "Item", a: c.item, b: c.item, state: "match" },
    {
      key: `qtd-${i}`,
      label: "Quantidade",
      a: `${c.counted} ${c.unit} recebidas`,
      b: `${c.invoiced} ${c.unit} cobradas`,
      state: "divergent",
    },
    { key: `dev-${i}`, label: "A devolver", a: `${c.invoiced - c.counted} ${c.unit}`, b: null, state: "divergent" },
  ]);

  return (
    <Panel title={divergenceLabel("E3")} description="Chegou menos do que a nota cobra" size="sm" padding="md">
      <ReconciliationDiff fields={fields} columns={["Recebimento", "Nota"]} showSummary={false} />
      <DataList
        divided
        aria-label="Fontes"
        items={evidence.map((e, index) => ({
          key: String(index),
          label: sourceLabel(String(e?.source ?? "")),
          value: <code>{e?.reference ?? ""}</code>,
        }))}
      />
    </Panel>
  );
}

registerEvidence("E3", QuantidadeMenorEvidence);
