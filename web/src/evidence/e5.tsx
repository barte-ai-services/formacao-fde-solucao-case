import { DataList, Panel, StatusBadge } from "@barte-ai-services/barte-ui-kit";
import type { EvidenceDto } from "../api/contract";
import { GenericEvidence } from "./GenericEvidence";
import { sourceLabel } from "./labels";
import { registerEvidence, type EvidenceProps } from "./registry";

/** As duas fontes que sustentam a E5 (#65): a nota na SEFAZ e a ordem que Compras não tem. */
const E5_SOURCES = ["sefaz", "erp_compras"] as const;

/**
 * E5 · Nota sem ordem (#65, história #34). Mostra a chave de acesso da nota (SEFAZ) e a ordem que
 * ela cita, ou "sem referência", contra Compras, que não tem essa ordem; e que a nota foi
 * encaminhada à coordenação (AC-4). A ordem provável vem na justificativa da proposta, não aqui.
 * Tolerante ao fio: mostra a evidência que vier e, sem nenhuma das duas, cai no genérico.
 */
function NotaSemOrdemEvidence({ divergence }: EvidenceProps) {
  const evidence = Array.isArray(divergence.evidence) ? divergence.evidence : [];
  const found = E5_SOURCES.map((source) => evidence.find((item) => item?.source === source)).filter(
    (item): item is EvidenceDto => item !== undefined,
  );
  if (found.length === 0) return <GenericEvidence divergence={divergence} />;

  const skus = Array.isArray(divergence.skus) ? divergence.skus : [];
  return (
    <Panel
      title="Nota sem ordem de compra"
      description={skus.length > 0 ? `Itens: ${skus.join(", ")}` : undefined}
      size="sm"
      padding="md"
    >
      <DataList
        divided
        aria-label="Evidências da nota sem ordem"
        items={found.map((item) => ({
          key: item.source,
          label: sourceLabel(item.source),
          value: (
            <>
              <span>{item.description ?? ""}</span> <code>{item.reference ?? ""}</code>
            </>
          ),
        }))}
      />
      <StatusBadge tone="waiting">Encaminhada à coordenação</StatusBadge>
    </Panel>
  );
}

registerEvidence("E5", NotaSemOrdemEvidence);
