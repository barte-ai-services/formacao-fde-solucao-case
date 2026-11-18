import { DataList, InlineEmpty, Panel } from "@barte-ai-services/barte-ui-kit";
import type { EvidenceProps } from "./registry";
import { sourceLabel } from "./labels";

/**
 * A evidência de qualquer divergência, sem componente próprio: cada registro com a fonte, a
 * referência e a descrição. Lê o fio com cuidado e nunca quebra: lista vazia, fonte ou código
 * desconhecidos aparecem como vieram.
 */
export function GenericEvidence({ divergence }: EvidenceProps) {
  const evidence = Array.isArray(divergence.evidence) ? divergence.evidence : [];
  const skus = Array.isArray(divergence.skus) ? divergence.skus : [];
  return (
    <Panel
      title={divergence.exceptionName}
      description={skus.length > 0 ? `Itens: ${skus.join(", ")}` : undefined}
      size="sm"
      padding="md"
    >
      {evidence.length === 0 ? (
        <InlineEmpty>Nenhuma evidência veio com esta divergência.</InlineEmpty>
      ) : (
        <DataList
          divided
          aria-label="Evidências"
          items={evidence.map((item, index) => ({
            key: String(index),
            label: sourceLabel(String(item?.source ?? "")),
            value: (
              <>
                {item?.description ?? ""} <code>{item?.reference ?? ""}</code>
              </>
            ),
          }))}
        />
      )}
    </Panel>
  );
}
