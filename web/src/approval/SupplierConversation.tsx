import type { ReactElement } from "react";
import { Button, Text } from "barte-design-system";
import { formatCurrency } from "@barte-ai-services/barte-ui-kit";
import { GridBadge } from "../components/GridBadge";
import type { ConfirmFailure } from "../components/supplier-request-state";
import { shortDate, type DocumentConfirmationView, type SupplierBlockStatus, type SupplierConversationView, type SupplierNextStep } from "../components/supplier-request-view";
import { useViewer } from "../shell/viewer";
import { texts } from "../texts";

const t = texts.supplierRequests.conversation;

/** #157 O tom do selo do cabeçalho do bloco. */
const BLOCK_TONE: Record<SupplierBlockStatus, "waiting" | "positive" | "negative" | "info"> = {
  waiting: "waiting",
  waitingCharged: "waiting",
  late: "negative",
  lateCharged: "negative",
  fulfilledToConfirm: "info",
  fulfilledToAnswer: "info",
  fulfilledToFollowUp: "info",
  fulfilled: "positive",
  partiallyFulfilled: "waiting",
  needsYou: "info",
  refused: "negative",
};

/** #157 O destaque de alerta do aviso de ordem escondida: borda, fundo e cor do texto de erro do design system, ícone ao lado. */
const ALERT_STYLE = {
  display: "flex",
  gap: "var(--spacing-sm)",
  alignItems: "flex-start",
  padding: "var(--spacing-sm) var(--spacing-md)",
  borderLeft: "4px solid var(--accent-red)",
  borderRadius: "var(--border-radius-sm)",
  background: "var(--accent-red-light)",
  color: "var(--accent-red-dark)",
} as const;

export interface SupplierConversationProps {
  conversation: SupplierConversationView;
  /** #157 O botão do próximo passo da leitura; quem confirma, encerra ou cobra é sempre uma pessoa. */
  onNextStep: (step: SupplierNextStep) => void;
  /** #157 A confirmação do documento está em curso: o botão fica parado e o clique não chama o passo de novo. */
  confirming?: boolean;
  /** #157 O motivo fechado da última confirmação que falhou; a tela mostra a mensagem dele e o botão segue lá. */
  confirmFailure?: ConfirmFailure;
}

/** #157 Quem confirmou e quando: "por você" é de quem olha a tela (como a cobrança, #157); outra pessoa aparece pelo e-mail do Access, em texto. */
function ConfirmationLine({ confirmation }: { confirmation: DocumentConfirmationView }): ReactElement {
  const viewer = useViewer();
  const by = confirmation.by === viewer ? texts.supplierRequest.byYou : texts.supplierRequest.by(confirmation.by);
  return (
    <div role="status">
      <Text as="p" variant="body-base">
        {t.confirmed(confirmation.document, by, shortDate(confirmation.on), confirmation.time)}
      </Text>
    </div>
  );
}

/**
 * #157 A conversa do bloco "Pedido ao fornecedor" (história #157): pedido enviado, resposta do fornecedor e leitura do agente.
 * #157 Cabe dentro do bloco da #156, abaixo da decisão registrada; o pedido e o e-mail em si são da #156.
 * #157 A região se chama "Conversa e leitura do pedido", para não repetir o nome do bloco da #156 na mesma gaveta; o título visível segue o wireframe.
 * #157 O texto do fornecedor é dado: sai como texto, nunca como marcação, e não muda decisão, título nem valor.
 */
export function SupplierConversation({ conversation, onNextStep, confirming = false, confirmFailure }: SupplierConversationProps): ReactElement {
  const { status, sent, reply, asOf, reading, confirmation } = conversation;
  const nextStep = reading.nextStep;
  return (
    <section aria-label={t.regionLabel} style={{ display: "grid", gap: "var(--spacing-md)" }}>
      <h3 style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", margin: 0 }}>
        <Text as="span" variant="label-lg">
          {t.title}
        </Text>
        <GridBadge tone={BLOCK_TONE[status]}>{t.blockStatus[status]}</GridBadge>
      </h3>

      <div>
        <h4 style={{ margin: 0 }}>{t.sentTitle}</h4>
        <Text as="p" variant="body-base">
          {t.sent(sent.document, formatCurrency(sent.amountCents / 100), shortDate(sent.sentOn), sent.sentTime, shortDate(sent.dueOn))}
        </Text>
        {sent.viewHref ? <a href={sent.viewHref}>{t.viewSent}</a> : null}
      </div>

      <div>
        <h4 style={{ margin: 0 }}>{t.replyTitle}</h4>
        {reply ? (
          <>
            <Text as="p" variant="caption-sm" color="var(--content-tertiary)">
              {t.replyReceived(shortDate(reply.receivedOn))}
            </Text>
            <blockquote style={{ margin: 0 }}>{reply.text}</blockquote>
            {reply.attachmentName ? (
              <Text as="p" variant="caption-sm">
                {t.attachment(reply.attachmentName)}
              </Text>
            ) : null}
            <Text as="p" variant="caption-sm" color="var(--content-tertiary)">
              {t.dataNotice}
            </Text>
          </>
        ) : (
          <Text as="p" variant="body-base">
            {/* #157 Lida, mas sem o texto (o contrato não o traz): não se diz "nenhuma resposta" de quem respondeu. */}
            {reading.replyOutcome === "no_reply" ? t.noReply(shortDate(asOf)) : t.replyNotShown}
          </Text>
        )}
        {reading.injectionExcerpt ? (
          // #157 O aviso é um alerta: papel alert, ícone e cor de alerta (tokens do design system). O trecho segue como texto, nunca marcação.
          <div role="alert" style={ALERT_STYLE}>
            <span aria-hidden="true">⚠</span>
            <div style={{ display: "grid", gap: "var(--spacing-2xs)" }}>
              <Text as="p" variant="label-lg">
                {t.injectionTitle}
              </Text>
              <Text as="p" variant="body-base">
                {t.injectionExcerpt(reading.injectionExcerpt)}
              </Text>
              <Text as="p" variant="body-base">
                {t.injectionUnchanged}
              </Text>
            </div>
          </div>
        ) : null}
      </div>

      <div>
        <h4 style={{ margin: 0 }}>{t.readingTitle}</h4>
        {reading.replyOutcome === "no_reply" ? null : (
          <>
            <Text as="p" variant="body-base">
              {t.outcomeLabel(t.outcome[reading.replyOutcome])}
            </Text>
            {reading.itemsFulfilled ? (
              <Text as="p" variant="body-base">
                {t.itemsFulfilled(reading.itemsFulfilled)}
              </Text>
            ) : null}
            {reading.documentCited ? (
              <Text as="p" variant="body-base">
                {t.documentCited(reading.documentCited)}
              </Text>
            ) : null}
          </>
        )}
        {reading.summary === "" ? null : (
          <Text as="p" variant="body-base">
            {t.summary(reading.summary)}
          </Text>
        )}
        {/* #157 Confirmado, a conversa diz quem e quando, e não sobra botão de confirmar. */}
        {confirmation ? <ConfirmationLine confirmation={confirmation} /> : null}
        {nextStep && !confirmation ? (
          <>
            <Text as="p" variant="body-base">
              {t.nextStepLabel}:
            </Text>
            {/* #157, AC-2 Confirmar leva o número citado no rótulo e fica parado enquanto confirma. */}
            <Button variant="outline" size="base" onClick={() => onNextStep(nextStep)} disabled={confirming}>
              {nextStep === "confirm_document" && reading.documentCited ? (confirming ? t.confirming : t.confirmDocument(reading.documentCited)) : t.nextStep[nextStep]}
            </Button>
          </>
        ) : null}
        {/* #157 O conflito segue visível mesmo quando a releitura tira o passo de confirmar (a confirmação, se existe, já mostra quem e quando). */}
        {confirmFailure && !confirmation ? (
          <div role="alert">
            <Text as="p" variant="body-base">
              {t.confirmFailed[confirmFailure]}
            </Text>
          </div>
        ) : null}
      </div>
    </section>
  );
}
