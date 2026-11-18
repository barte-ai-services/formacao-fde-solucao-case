import { DataList, Panel, ReconciliationDiff, type ComparisonField } from "@barte-ai-services/barte-ui-kit";
import { GenericEvidence } from "./GenericEvidence";
import { sourceLabel } from "./labels";
import { registerEvidence, type EvidenceProps } from "./registry";

/** #97: uma evidência como veio no fio; nenhum campo é confiável até ser lido por `text`. */
interface LooseEvidence {
  source?: unknown;
  reference?: unknown;
  description?: unknown;
}

/** #97: os campos da E2 tirados das evidências; `null` é o que não veio ou não foi lido. */
interface SwappedItem {
  order: string | null;
  ordered: string | null;
  received: string | null;
  amount: string | null;
}

/** #97: a evidência da SEFAZ que o checkItemTrocado emite (#36), com o valor no fim. */
const SEFAZ_CHARGE = /^Nota cobra (.+) por (-?R\$\s?[\d.]+,\d{2})$/;
const ORDER_ASKS = /pede (.+?), não /;

/** #97: texto e número viram texto; o resto do fio (objeto, vazio, nulo) vira `null`. */
function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** #97: cada campo que não casa com o formato do domínio volta o texto da fonte como veio. */
function readSwappedItem(evidence: readonly LooseEvidence[]): SwappedItem {
  const of = (source: string) => evidence.find((item) => item.source === source);
  const purchases = of("erp_compras");
  const purchasesText = text(purchases?.description);
  const sefazText = text(of("sefaz")?.description);
  const registryText = text(of("erp_cadastro")?.description);
  const charge = sefazText === null ? null : SEFAZ_CHARGE.exec(sefazText);
  const asks = purchasesText === null ? null : ORDER_ASKS.exec(purchasesText);
  return {
    order: text(purchases?.reference),
    ordered: text(asks?.[1]) ?? purchasesText,
    received: text(charge?.[1]) ?? registryText ?? sefazText,
    amount: text(charge?.[2]),
  };
}

/** #97 (#94/AC-1, AC-2): o item que a ordem pede contra o item que a nota cobra no lugar, e o valor dele. */
function ItemTrocadoEvidence({ divergence }: EvidenceProps) {
  const evidence: LooseEvidence[] = (Array.isArray(divergence.evidence) ? (divergence.evidence as unknown[]) : []).filter(
    (item): item is LooseEvidence => item !== null && typeof item === "object",
  );
  if (evidence.length === 0) return <GenericEvidence divergence={divergence} />;

  const skus = Array.isArray(divergence.skus) ? divergence.skus.map(text).filter((sku) => sku !== null) : [];
  const swapped = readSwappedItem(evidence);
  const parsed = Object.values(swapped).some((value) => value !== null);
  const fields: ComparisonField[] = [
    {
      key: "order",
      label: "Ordem de compra",
      a: swapped.order,
      b: swapped.order,
      state: swapped.order === null ? "missing" : "match",
    },
    { key: "item", label: "Item", a: swapped.ordered, b: swapped.received, state: "divergent", note: "item trocado" },
    {
      key: "amount",
      label: "Valor do item trocado",
      a: null,
      b: swapped.amount ?? "Valor indisponível",
      state: "divergent",
    },
  ];

  return (
    <Panel
      title={divergence.exceptionName}
      description={skus.length > 0 ? `Itens: ${skus.join(", ")}` : undefined}
      size="sm"
      padding="md"
    >
      {parsed ? (
        <ReconciliationDiff
          columns={["Fonte", "Nota fiscal"]}
          fields={fields}
          showSummary
          variant="grid"
          ariaLabel="Item pedido contra item cobrado"
        />
      ) : null}
      <DataList
        divided
        aria-label="Evidências"
        items={evidence.map((item, index) => ({
          key: String(index),
          label: sourceLabel(text(item.source) ?? ""),
          value: (
            <>
              <span>{text(item.description) ?? ""}</span> <code>{text(item.reference) ?? ""}</code>
            </>
          ),
        }))}
      />
    </Panel>
  );
}

registerEvidence("E2", ItemTrocadoEvidence);
