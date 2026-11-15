import { AiSourceBadge, Block, DataList, Panel } from "@barte-ai-services/barte-ui-kit";
import { Alert, Text } from "barte-design-system";
import { divergenceLabel } from "../evidence/labels";

/** De onde o Claude tirou cada evidência do dossiê. */
export type DossierEvidenceSource = "nota" | "ordem" | "cadastro" | "recebimento" | "historico";

export type DossierEvidenceDto = {
  chave: string;
  rotulo: string;
  valor: string;
  fonte: DossierEvidenceSource;
};

export type DossierDivergenceDto = {
  classificacao: string;
  oQueDiverge: string;
  evidencias: DossierEvidenceDto[];
};

export type DossierUnavailableReason =
  | "claude_falhou"
  | "numero_nao_confere"
  | "forma_invalida"
  | "sem_credencial"
  | "pendente";

/** O campo `dossier` da proposta, como a API devolve (#68). */
export type DossierDto =
  | {
      status: "pronto";
      resumo: string;
      divergencias: DossierDivergenceDto[];
      historicoFornecedor: string;
      geradoEm: string;
      modelo: string;
    }
  | {
      status: "indisponivel";
      motivo: DossierUnavailableReason;
      aviso: string;
      geradoEm: string | null;
    };

export const DOSSIER_UNAVAILABLE_TITLE = "Não há dossiê do Claude para esta proposta.";
export const DOSSIER_NOT_GENERATED =
  "O dossiê ainda não foi gerado. Decida pelas divergências e evidências da conferência.";
export const DOSSIER_RULE_NOTE =
  "O Claude explica; quem decide é a regra ou você. A ação, o nível e o valor vêm da regra.";

const SOURCE_LABEL: Record<DossierEvidenceSource, string> = {
  nota: "Nota fiscal",
  ordem: "Ordem de compra",
  cadastro: "Cadastro",
  recebimento: "Recebimento",
  historico: "Histórico",
};

function sourceLabel(source: string): string {
  return Object.hasOwn(SOURCE_LABEL, source) ? SOURCE_LABEL[source as DossierEvidenceSource] : source;
}

export interface DossierProps {
  /** `null` ou ausente: o dossiê ainda não foi gerado para esta proposta. */
  dossier: DossierDto | null | undefined;
}

/**
 * O dossiê do Claude na gaveta da proposta, como no wireframe aprovado. O Claude explica a
 * exceção com as evidências; não decide nada: a ação, o nível e o valor vêm da regra. Sem dossiê
 * pronto, a gaveta avisa e a decisão segue pela conferência.
 */
export function Dossier({ dossier }: DossierProps) {
  if (!dossier || dossier.status !== "pronto") {
    const aviso = dossier?.status === "indisponivel" && dossier.aviso ? dossier.aviso : DOSSIER_NOT_GENERATED;
    return <Alert variant="info" title={DOSSIER_UNAVAILABLE_TITLE} description={aviso} showCloseButton={false} />;
  }
  const divergencias = Array.isArray(dossier.divergencias) ? dossier.divergencias : [];
  return (
    <Panel title="Dossiê do Claude" aside={<AiSourceBadge source="ai" label="Claude" size="sm" />} size="sm">
      <Text variant="body-sm" color="var(--content-primary)">
        {dossier.resumo}
      </Text>
      {divergencias.map((divergencia, index) => {
        const evidencias = Array.isArray(divergencia?.evidencias) ? divergencia.evidencias : [];
        return (
          <Block
            key={`${divergencia?.classificacao ?? ""}-${index}`}
            title={divergenceLabel(String(divergencia?.classificacao ?? ""))}
            description={divergencia?.oQueDiverge}
            size="sm"
            headingLevel={4}
          >
            <DataList
              size="sm"
              divided
              aria-label="Evidências do dossiê"
              items={evidencias.map((evidencia, i) => ({
                key: evidencia?.chave || String(i),
                label: evidencia?.rotulo ?? "",
                value: (
                  <>
                    <span>{evidencia?.valor ?? ""}</span>{" "}
                    <Text as="span" variant="body-xs" color="var(--content-secondary)">
                      {sourceLabel(String(evidencia?.fonte ?? ""))}
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
          {dossier.historicoFornecedor}
        </Text>
      </Block>
      <Text variant="body-xs" color="var(--content-secondary)">
        {DOSSIER_RULE_NOTE}
      </Text>
    </Panel>
  );
}
