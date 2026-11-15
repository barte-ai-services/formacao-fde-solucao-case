import { Panel, ReconciliationDiff, type ComparisonField } from "@barte-ai-services/barte-ui-kit";
import { Alert } from "barte-design-system";
import type { EvidenceDto } from "../api/contract";
import { GenericEvidence } from "./GenericEvidence";
import { registerEvidence, type EvidenceProps } from "./registry";

/** #66: o que a frase da evidência do checkItemSemCadastro (#35) diz do item; o que não casa fica null. */
interface UnregisteredItem {
  description: string | null;
  value: string | null;
  supplierCode: string | null;
}

const DESCRIPTION = /^O item "(.+)" \(código do fornecedor /;
const VALUE = /valor (R\$ [\d.]+,\d{2})\)/;

/** #66: o código do fornecedor é a parte da referência depois da barra (`<fornecedor>/<código>`). */
function supplierCodeOf(reference: unknown): string | null {
  if (typeof reference !== "string") return null;
  const code = reference.slice(reference.indexOf("/") + 1);
  return reference.includes("/") && code !== "" ? code : null;
}

function parseItem(evidence: EvidenceDto): UnregisteredItem {
  const text = typeof evidence.description === "string" ? evidence.description : "";
  return {
    description: DESCRIPTION.exec(text)?.[1] ?? null,
    value: VALUE.exec(text)?.[1] ?? null,
    supplierCode: supplierCodeOf(evidence.reference),
  };
}

/** #66: os campos de um item. O que a evidência não traz mostra a frase dela, nada é inventado. */
function fieldsOf(evidence: EvidenceDto, skus: string[], order: EvidenceDto | undefined): ComparisonField[] {
  const item = parseItem(evidence);
  const sentence = evidence.description ?? "";
  const sku = skus[0];
  const failed = (key: string, label: string): ComparisonField => ({
    key,
    label,
    a: null,
    b: "não encontrado",
    state: "missing",
  });
  return [
    {
      key: "item",
      label: "Item da nota",
      a: item.description ?? sentence,
      b: "fora do cadastro",
      state: "divergent",
    },
    { key: "codigo", label: "Código do fornecedor", a: item.supplierCode ?? "não informado", b: null, state: "missing" },
    { key: "sku", label: "SKU", a: sku ?? "SKU vazio", b: null, state: "missing" },
    failed("busca-sku", "Busca por SKU"),
    failed("busca-codigo", "Busca por código do fornecedor"),
    failed("busca-descricao", "Busca por descrição"),
    ...(order ? [orderField(order)] : []),
    ...(item.value
      ? [{ key: "risco", label: "Valor em risco", a: null, b: item.value, state: "divergent" } as ComparisonField]
      : []),
  ];
}

const REASON = /^Ordem .+ travada: (.+)$/;

/** #66: a ordem travada, como no wireframe ("Ordem: travada"), com o motivo quando a frase o traz. */
function orderField(order: EvidenceDto): ComparisonField {
  const text = typeof order.description === "string" ? order.description : "";
  return {
    key: "ordem",
    label: "Ordem",
    a: "travada",
    b: String(order.reference ?? ""),
    state: "divergent",
    note: REASON.exec(text)?.[1] ?? text,
  };
}

/**
 * E8 · Item sem cadastro. #66 (história #35): o item da nota que o cadastro do fornecedor não tem, as
 * três buscas que falharam, o valor em risco, e para onde a aprovação manda (AC-4 e AC-5). Evidência
 * ausente cai no genérico; frase fora do formato do #35 mostra a frase no lugar do campo.
 */
function UnregisteredItemEvidence({ divergence }: EvidenceProps) {
  const evidence = Array.isArray(divergence.evidence) ? divergence.evidence : [];
  const record = evidence.find((e) => e?.source === "erp_cadastro");
  if (!record) return <GenericEvidence divergence={divergence} />;
  const order = evidence.find((e) => e?.source === "erp_compras");
  const skus = Array.isArray(divergence.skus) ? divergence.skus : [];

  return (
    <Panel
      title={divergence.exceptionName}
      description={`Evidência: Cadastro do ERP ${record.reference ?? ""}`}
      size="sm"
      padding="md"
    >
      <ReconciliationDiff
        columns={["Nota fiscal", "Cadastro do ERP"]}
        fields={fieldsOf(record, skus, order)}
        showSummary
        variant="grid"
        ariaLabel="Item sem cadastro"
      />
      <Alert
        variant="info"
        title="Para onde a aprovação vai"
        description="A régua encaminha a E8 à coordenação, ou acima quando a nota passa de R$ 100 mil. Aprovar manda o item ao Cadastro, para ser cadastrado antes de a nota seguir."
      />
    </Panel>
  );
}

registerEvidence("E8", UnregisteredItemEvidence);
