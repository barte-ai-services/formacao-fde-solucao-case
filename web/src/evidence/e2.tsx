import { DataList, Panel, ReconciliationDiff, type ComparisonField } from "@barte-ai-services/barte-ui-kit";
import type { EvidenceDto } from "../api/contract";
import { GenericEvidence } from "./GenericEvidence";
import { divergenceLabel, sourceLabel } from "./labels";
import { registerEvidence, type EvidenceProps } from "./registry";

/** Os campos da E2, tirados das evidências. `null` é o que não veio. */
interface ItemTrocado {
  ordem: string | null;
  pedido: string | null;
  veio: string | null;
  valor: string | null;
}

const texto = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * O trecho de `text` entre `start` e `end`. `null` quando o formato não bate.
 * `lastEnd` corta na última ocorrência de `end`: o valor fica no fim e a descrição pode conter o separador.
 */
function between(text: string | null, start: string, end: string, lastEnd = false): string | null {
  if (text === null) return null;
  const from = text.indexOf(start);
  if (from < 0) return null;
  const rest = text.slice(from + start.length);
  const to = lastEnd ? rest.lastIndexOf(end) : rest.indexOf(end);
  return to < 0 ? null : texto(rest.slice(0, to).trim());
}

/** O que vem depois da última ocorrência de `marker`. */
function after(text: string | null, marker: string): string | null {
  if (text === null) return null;
  const at = text.lastIndexOf(marker);
  return at < 0 ? null : texto(text.slice(at + marker.length).trim());
}

/**
 * Lê as evidências que o domínio emite para a E2 (#36, #97): o ERP Compras diz o que a ordem pede, a
 * nota da SEFAZ diz o item que veio e quanto ele custa, o ERP Cadastro confirma o produto. Cada campo
 * que não casa com o formato volta o texto da fonte como veio.
 */
function readItemTrocado(evidence: readonly EvidenceDto[]): ItemTrocado {
  const of = (source: string) => evidence.find((item) => item?.source === source);
  const compras = of("erp_compras");
  const sefaz = of("sefaz");
  const cadastro = of("erp_cadastro");
  const comprasText = texto(compras?.description);
  const sefazText = texto(sefaz?.description);
  const cadastroText = texto(cadastro?.description);
  return {
    ordem: texto(compras?.reference),
    pedido: between(comprasText, "pede ", ", não ") ?? comprasText,
    veio: between(sefazText, "Nota cobra ", " por ", true) ?? cadastroText ?? sefazText,
    valor: after(sefazText, " por "),
  };
}

/** E2 · Item trocado: o item que a ordem pede contra o item que a nota cobra no lugar, e o valor dele. */
function ItemTrocadoEvidence({ divergence }: EvidenceProps) {
  const evidence = (Array.isArray(divergence.evidence) ? divergence.evidence : []).filter(
    (item): item is EvidenceDto => item !== null && typeof item === "object",
  );
  const skus = Array.isArray(divergence.skus) ? divergence.skus.filter((sku) => typeof sku === "string") : [];
  const campos = readItemTrocado(evidence);
  if (campos.ordem === null && campos.pedido === null && campos.veio === null && campos.valor === null) {
    return <GenericEvidence divergence={divergence} />;
  }

  const fields: ComparisonField[] = [
    { key: "ordem", label: "Ordem de compra", a: campos.ordem, b: campos.ordem, state: "match" },
    { key: "item", label: "Item", a: campos.pedido, b: campos.veio, state: "divergent", note: "item trocado" },
    {
      key: "valor",
      label: "Valor do item trocado",
      a: null,
      b: campos.valor ?? "Valor indisponível",
      state: "divergent",
    },
  ];

  return (
    <Panel
      title={divergenceLabel("E2")}
      description={skus.length > 0 ? `Itens: ${skus.join(", ")}` : undefined}
      size="sm"
      padding="md"
    >
      <ReconciliationDiff
        columns={["Ordem de compra", "Nota fiscal"]}
        fields={fields}
        showSummary={false}
        variant="grid"
        ariaLabel="Item pedido contra item cobrado"
      />
      <DataList
        divided
        aria-label="Evidências"
        items={evidence.map((item, index) => ({
          key: String(index),
          label: sourceLabel(String(item.source ?? "")),
          value: (
            <>
              {item.description ?? ""} <code>{item.reference ?? ""}</code>
            </>
          ),
        }))}
      />
    </Panel>
  );
}

registerEvidence("E2", ItemTrocadoEvidence);
