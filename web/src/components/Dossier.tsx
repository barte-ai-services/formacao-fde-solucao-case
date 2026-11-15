import { AiSourceBadge, Block, DataList, Panel } from "@barte-ai-services/barte-ui-kit";
import { Alert, Text } from "barte-design-system";
import type { JSX } from "react";
import type { DossierField } from "../api/contract";
import { texts } from "../texts";

/** #68: o dossiê pronto, como o domínio o define. */
type ReadyDossier = Extract<DossierField, { status: "ready" }>;
/** #68: as evidências de uma divergência do dossiê. */
type DossierEvidenceList = ReadyDossier["divergences"][number]["evidence"];
/** #68: de onde o Claude tirou cada evidência do dossiê. */
type DossierEvidenceSource = DossierEvidenceList[number]["source"];

export const DOSSIER_UNAVAILABLE_TITLE = texts.dossier.unavailableTitle;
export const DOSSIER_NOT_GENERATED = texts.dossier.notGenerated;
export const DOSSIER_RULE_NOTE = texts.dossier.ruleNote;

const SOURCE_LABEL: Record<DossierEvidenceSource, string> = texts.dossier.source;

function sourceLabel(source: string): string {
  return Object.hasOwn(SOURCE_LABEL, source) ? SOURCE_LABEL[source as DossierEvidenceSource] : source;
}

export interface DossierProps {
  /** #68: `null` ou ausente: o dossiê ainda não foi gerado para esta proposta. */
  dossier: DossierField | null | undefined;
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
    <Panel title={texts.dossier.panelTitle} aside={<AiSourceBadge source="ai" label={texts.dossier.badge} size="sm" />} size="sm">
      <Text variant="body-sm" color="var(--content-primary)">
        {dossier.summary}
      </Text>
      {divergences.map((divergence, index) => {
        const evidenceItems: DossierEvidenceList = Array.isArray(divergence?.evidence) ? divergence.evidence : [];
        return (
          <Block
            key={`${divergence?.classification ?? ""}-${index}`}
            title={divergence?.exceptionName ?? String(divergence?.classification ?? "")}
            description={divergence?.whatDiverges}
            size="sm"
            headingLevel={4}
          >
            <DataList
              size="sm"
              divided
              aria-label={texts.dossier.evidenceLabel}
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
      <Block title={texts.dossier.supplierHistory} size="sm" headingLevel={4}>
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
