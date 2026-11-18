import { AiSourceBadge, Block, DataList, Panel } from "@barte-ai-services/barte-ui-kit";
import { Alert, Button, Text } from "barte-design-system";
import type { JSX, ReactNode } from "react";
import type { DossierField, ProposalDossierDto } from "../api/contract";
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

/** #130 Os motivos de falha que têm mensagem própria na tabela da issue. */
type FailedReason = keyof typeof texts.dossier.failed;
const isFailed = (reason: string): reason is FailedReason => Object.hasOwn(texts.dossier.failed, reason);

/** #130 "10h14", no fuso da operação, como o wireframe. Vazio quando o horário não veio. */
export function clockTime(iso: string | null | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).replace(":", "h");
}

export interface DossierProps {
  /** #68: `null` ou ausente: o dossiê ainda não foi gerado para esta proposta. #130: ou `generating`. */
  dossier: ProposalDossierDto | DossierField | null | undefined;
  /** #130 Pedir ao Claude (ou de novo). Sem ele, a gaveta só mostra o dossiê, sem botão. */
  onRequest?: () => void;
  /** #130 O aviso do pedido recusado (409, 429). */
  message?: string | null;
  busy?: boolean;
  /** #130 AC-4 Uma versão nova está sendo escrita: o dossiê pronto fica na tela, com o aviso, e o botão desabilitado. */
  renewing?: boolean;
}

/** #130 A moldura de IA: o cabeçalho é sempre "Dossiê do Claude" com o selo. */
function AiPanel({ children, live }: { children: ReactNode; live?: boolean }): JSX.Element {
  return (
    <div className="pagar-dossier-ai" aria-busy={live || undefined}>
      <Panel title={texts.dossier.panelTitle} aside={<AiSourceBadge source="ai" label={texts.dossier.badge} size="sm" />} size="sm">
        {children}
      </Panel>
    </div>
  );
}

function RequestButton({ label, onRequest, busy }: { label: string; onRequest?: () => void; busy?: boolean }): JSX.Element | null {
  if (!onRequest) return null;
  return (
    <div className="pagar-dossier-actions">
      <Button variant="outline" size="sm" onClick={onRequest} disabled={busy}>
        {label}
      </Button>
    </div>
  );
}

function Message({ text }: { text?: string | null }): JSX.Element | null {
  return text ? <p role="status">{text}</p> : null;
}

/**
 * O dossiê do Claude na gaveta da proposta, como no wireframe aprovado. O Claude explica a
 * exceção com as evidências; não decide nada: a ação, o nível e o valor vêm da regra. Sem dossiê
 * pronto, a gaveta avisa e a decisão segue pela conferência.
 */
export function Dossier({ dossier, onRequest, message, busy, renewing }: DossierProps): JSX.Element {
  // #130 Gerando: o brilho nas linhas e quem pediu, e quando.
  if (dossier?.status === "generating") {
    const time = clockTime(dossier.requestedAt);
    return (
      <AiPanel live>
        <div className="pagar-dossier-shimmer" aria-hidden="true">
          <span />
        </div>
        <Text variant="body-sm" color="var(--content-primary)">
          {`✦ ${texts.dossier.generating}`}
        </Text>
        <div className="pagar-dossier-shimmer" aria-hidden="true">
          <span />
          <span />
        </div>
        {time ? (
          <Text variant="body-xs" color="var(--content-secondary)">
            {dossier.trigger === "event" ? texts.dossier.startedAt(time) : texts.dossier.requestedAt(time)}
          </Text>
        ) : null}
        <Message text={message} />
      </AiPanel>
    );
  }
  if (!dossier || dossier.status !== "ready") {
    const reason = dossier?.status === "unavailable" ? String(dossier.reason) : "pending";
    // #130 Não deu certo: a mensagem do motivo; a decisão continua valendo sem o dossiê.
    if (isFailed(reason)) {
      return (
        <AiPanel>
          <Alert variant="warning" title={texts.dossier.failed[reason]} description={texts.dossier.stillValid} showCloseButton={false} />
          <Message text={message} />
          <RequestButton label={texts.dossier.retry} onRequest={onRequest} busy={busy} />
        </AiPanel>
      );
    }
    // #68 A leitura falhou: o aviso da API, sem pedir uma geração nova.
    if (reason === "read_failed" || !onRequest) {
      const notice = dossier?.status === "unavailable" && dossier.notice ? dossier.notice : DOSSIER_NOT_GENERATED;
      return <Alert variant="info" title={DOSSIER_UNAVAILABLE_TITLE} description={notice} showCloseButton={false} />;
    }
    // #130 Ainda não gerado: o convite para pedir ao Claude.
    return (
      <AiPanel>
        <Text variant="body-sm" color="var(--content-primary)">
          {texts.dossier.notYet}
        </Text>
        <Message text={message} />
        <RequestButton label={texts.dossier.ask} onRequest={onRequest} busy={busy} />
      </AiPanel>
    );
  }
  const divergences = Array.isArray(dossier.divergences) ? dossier.divergences : [];
  const written = clockTime(dossier.generatedAt);
  return (
    <AiPanel live={renewing}>
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
      {written ? (
        <Text variant="body-xs" color="var(--content-secondary)">
          {texts.dossier.writtenAt(written)}
        </Text>
      ) : null}
      {renewing ? <p role="status">{texts.dossier.renewing}</p> : null}
      <Message text={message} />
      <RequestButton label={texts.dossier.again} onRequest={onRequest} busy={busy || renewing} />
    </AiPanel>
  );
}
