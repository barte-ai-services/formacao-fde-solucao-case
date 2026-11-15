import { AiSourceBadge, Block, DataList, Panel } from "@barte-ai-services/barte-ui-kit";
import { Alert, Text } from "barte-design-system";
import type { JSX } from "react";
import { divergenceLabel } from "../evidence/labels";

/** De onde o Claude tirou cada evidência do dossiê. */
export type DossierEvidenceSource = "invoice" | "purchase_order" | "registry" | "receipt" | "history";

export type DossierEvidenceDto = {
  key: string;
  label: string;
  value: string;
  source: DossierEvidenceSource;
};

export type DossierDivergenceDto = {
  classification: string;
  whatDiverges: string;
  evidence: DossierEvidenceDto[];
};

export type DossierUnavailableReason =
  | "claude_failed"
  | "number_mismatch"
  | "invalid_shape"
  | "pending";

/** O campo `dossier` da proposta, como a API devolve (#68). */
export type DossierDto =
  | {
      status: "ready";
      summary: string;
      divergences: DossierDivergenceDto[];
      supplierHistory: string;
      generatedAt: string;
      model: string;
    }
  | {
      status: "unavailable";
      reason: DossierUnavailableReason;
      notice: string;
      generatedAt: string | null;
    };

export const DOSSIER_UNAVAILABLE_TITLE = "Não há dossiê do Claude para esta proposta.";
export const DOSSIER_NOT_GENERATED =
  "O dossiê ainda não foi gerado. Decida pelas divergências e evidências da conferência.";
export const DOSSIER_RULE_NOTE =
  "O Claude explica; quem decide é a regra ou você. A ação, o nível e o valor vêm da regra.";

const SOURCE_LABEL: Record<DossierEvidenceSource, string> = {
  invoice: "Nota fiscal",
  purchase_order: "Ordem de compra",
  registry: "Cadastro",
  receipt: "Recebimento",
  history: "Histórico",
};

function sourceLabel(source: string): string {
  return Object.hasOwn(SOURCE_LABEL, source) ? SOURCE_LABEL[source as DossierEvidenceSource] : source;
}

export interface DossierProps {
  /** #68: `null` ou ausente: o dossiê ainda não foi gerado para esta proposta. */
  dossier: DossierDto | null | undefined;
}

/**
 * O dossiê do Claude na gaveta da proposta, como no wireframe aprovado. O Claude explica a
 * exceção com as evidências; não decide nada: a ação, o nível e o valor vêm da regra. Sem dossiê
 * pronto, a gaveta avisa e a decisão segue pela conferência.
 */
export function Dossier({ dossier }: DossierProps): JSX.Element {
  if (!dossier || dossier.status !== "ready") {
    const notice = dossier?.status === "unavailable" && dossier.notice ? dossier.notice : DOSSIER_NOT_GENERATED;
    return <Alert variant="info" title={DOSSIER_UNAVAILABLE_TITLE} description={notice} showCloseButton={false} />;
  }
  const divergences = Array.isArray(dossier.divergences) ? dossier.divergences : [];
  return (
    <Panel title="Dossiê do Claude" aside={<AiSourceBadge source="ai" label="Claude" size="sm" />} size="sm">
      <Text variant="body-sm" color="var(--content-primary)">
        {dossier.summary}
      </Text>
      {divergences.map((divergence, index) => {
        const evidenceItems = Array.isArray(divergence?.evidence) ? divergence.evidence : [];
        return (
          <Block
            key={`${divergence?.classification ?? ""}-${index}`}
            title={divergenceLabel(String(divergence?.classification ?? ""))}
            description={divergence?.whatDiverges}
            size="sm"
            headingLevel={4}
          >
            <DataList
              size="sm"
              divided
              aria-label="Evidências do dossiê"
              items={evidenceItems.map((item, i) => ({
                key: item?.key || String(i),
                label: item?.label ?? "",
                value: (
                  <>
                    <span>{item?.value ?? ""}</span>{" "}
                    <Text as="span" variant="body-xs" color="var(--content-secondary)">
                      {sourceLabel(String(item?.source ?? ""))}
                    </Text>
                  </>
                ),
              }))}
            />
          </Block>
        );
      })}
      <Block title="Histórico do fornecedor" size="sm" headingLevel={4}>
        <Text variant="body-sm" color="var(--content-primary)">
          {dossier.supplierHistory}
        </Text>
      </Block>
      <Text variant="body-xs" color="var(--content-secondary)">
        {DOSSIER_RULE_NOTE}
      </Text>
    </Panel>
  );
}
