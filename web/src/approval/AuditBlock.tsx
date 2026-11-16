import type { JSX, ReactNode } from "react";
import { Alert, Text } from "barte-design-system";
import { Block } from "@barte-ai-services/barte-ui-kit";
import { texts } from "../texts";

/** #231 O modelo de visão do bloco "Agente auditor": a camada de estado o deriva da auditoria; o bloco só o desenha. */
export type AuditBlockView =
  | { kind: "pending" }
  | { kind: "not-audited"; reason: string }
  | {
      kind: "audited";
      tone: "positive" | "alert";
      verdict: string;
      raised?: string | null;
      injection?: string | null;
      justification: string;
      footer: string;
    };

const TONE_VARIANT = { positive: "success", alert: "warning" } as const;

/** #231 A moldura do bloco: a região nomeada "Agente auditor" que o próprio Block desenha, só leitura, sem controle. */
function Frame({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Block title={texts.auditor.title} size="sm">
      {children}
    </Block>
  );
}

/**
 * #231 O bloco "Agente auditor" da gaveta: o veredito do auditor sobre a proposta, em texto puro.
 * O trecho da injeção é um nó de texto dentro de uma citação, nunca HTML; a quebra de linha vale por CSS.
 */
export function AuditBlock({ view }: { view: AuditBlockView }): JSX.Element {
  if (view.kind === "pending") {
    return (
      <Frame>
        <Alert variant="info" title={texts.auditor.pending} showCloseButton={false} />
      </Frame>
    );
  }
  if (view.kind === "not-audited") {
    return (
      <Frame>
        <Alert variant="info" title={texts.auditor.notAudited} description={view.reason} showCloseButton={false} />
        <Text variant="body-sm" color="var(--content-primary)">
          {texts.auditor.decideByEvidence}
        </Text>
      </Frame>
    );
  }
  return (
    <Frame>
      <Alert variant={TONE_VARIANT[view.tone]} title={view.verdict} showCloseButton={false} {...(view.raised ? { description: view.raised } : {})} />
      {view.injection ? (
        <>
          <Alert variant="warning" title={texts.auditor.injectionNotice} showCloseButton={false} />
          <blockquote style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{view.injection}</blockquote>
        </>
      ) : null}
      <div style={{ whiteSpace: "pre-line" }}>
        <Text variant="body-sm" color="var(--content-primary)">
          {view.justification}
        </Text>
      </div>
      <Text variant="body-xs" color="var(--content-secondary)">
        {view.footer}
      </Text>
    </Frame>
  );
}
