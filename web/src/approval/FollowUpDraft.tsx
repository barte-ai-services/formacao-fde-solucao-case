import { useId, type ReactElement } from "react";
import { Button, Text } from "barte-design-system";
import { MAX_FOLLOW_UP_TEMPLATE } from "../api/contract";
import { shortDate, type FollowUpDraftView } from "../components/supplier-request-view";
import { useViewer } from "../shell/viewer";
import { texts } from "../texts";

const t = texts.supplierRequests.draft;

/** #19 Em que ponto está o rascunho: para revisar, enviando, enviado ou com o envio falho. */
export type FollowUpPhase = FollowUpPhaseState["phase"];

/** #59 O motivo fechado de um salvamento recusado: 422 (o texto não confere), 409 (o pedido mudou) ou outro; o texto do servidor não chega à tela (layer-exposure). */
export type SaveFailure = "invalid" | "conflict" | "unknown";

/** #19 O motivo do envio falho é um código fechado: o texto de um erro de fora não chega à tela (layer-exposure). */
export type FollowUpFailure = "mailRefused" | "unknown";

/** #19 O que cada fase exige: `sent` traz quando saiu e `failed` traz o motivo, então nenhuma tela desenha data ou motivo vazio. */
export type FollowUpPhaseState =
  | { phase: "review" }
  | { phase: "sending" }
  /** #5/AC-4 `sentBy` é quem o servidor diz ter enviado; ausente, nulo ou igual a quem olha a tela, a frase diz "por você". */
  | { phase: "sent"; sentOn: string; sentTime?: string; sentBy?: string | null }
  | { phase: "failed"; failure: FollowUpFailure };

export type FollowUpDraftProps = FollowUpDraftBaseProps & FollowUpPhaseState;

interface FollowUpDraftBaseProps {
  draft: FollowUpDraftView;
  /** #19 Só o texto do e-mail se libera para edição; para, assunto, prazo e anexo ficam travados. Editando, o campo abre com o molde `draft.template` (#59). */
  editing: boolean;
  /** #59 O PATCH do texto está em curso: Salvar e Cancelar ficam parados. */
  saving?: boolean;
  /** #59 O motivo fechado do último salvamento recusado; a edição segue aberta. */
  saveFailure?: SaveFailure;
  /** #21 Sem `onEdit`, o texto não se edita e o botão "Editar" não existe: o envio da cobrança não leva texto (o servidor manda o rascunho que guarda, #36). */
  onEdit?: () => void;
  /** #59 Salvar chama o PATCH da cobrança; cancelar fecha a edição sem salvar. */
  onSave: () => void;
  onCancelEdit: () => void;
  onBodyChange: (body: string) => void;
  onSend: () => void;
  onDiscard: () => void;
  onRetry: () => void;
}

function Field({ label, children, keepLineBreaks = false }: { label: string; children: string; keepLineBreaks?: boolean }): ReactElement {
  return (
    <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
      <Text as="span" variant="caption-sm" color="var(--content-tertiary)">
        {label}
      </Text>
      {/* #65/AC-3 O corpo do e-mail traz quebras de linha: `pre-line` as mantém e ainda quebra a linha longa. */}
      <Text as="span" variant="body-base" style={keepLineBreaks ? { whiteSpace: "pre-line" } : undefined}>
        {children}
      </Text>
    </div>
  );
}

/** #5/AC-4 O rascunho da cobrança no formato do pedido da #3 (para, prazo, assunto, texto, anexo): a cobrança só sai no clique em enviar. */
export function FollowUpDraft(props: FollowUpDraftProps): ReactElement {
  const { draft, editing, saving = false, saveFailure, onEdit, onSave, onCancelEdit, onBodyChange, onSend, onDiscard, onRetry } = props;
  const phase = props.phase;
  const viewer = useViewer();
  const counterId = useId();
  if (props.phase === "sent") {
    // #5/AC-4 O "por você" é de quem olha a tela, como no pedido da #3 (#17): outro remetente aparece pelo nome.
    const by = props.sentBy === undefined || props.sentBy === null || props.sentBy === viewer ? texts.supplierRequest.byYou : texts.supplierRequest.by(props.sentBy);
    return (
      <div role="status">
        <Text as="p" variant="body-base">
          {t.sent(by, shortDate(props.sentOn), props.sentTime, draft.dueOn === null ? null : shortDate(draft.dueOn))}
        </Text>
      </div>
    );
  }
  const busy = phase === "sending";
  return (
    <section aria-label={t.title} style={{ display: "grid", gap: "var(--spacing-sm)" }}>
      <h4 style={{ margin: 0 }}>{t.title}</h4>
      <Text as="p" variant="caption-sm" color="var(--content-tertiary)">
        {t.subtitle}
      </Text>
      {props.phase === "failed" ? (
        <div role="alert">
          <Text as="p" variant="body-base">
            {props.failure === "mailRefused" ? t.failed.mailRefused : t.failed.unknown}
          </Text>
          <Text as="p" variant="caption-sm">
            {t.failedKept}
          </Text>
        </div>
      ) : null}
      <Field label={t.to}>{draft.to}</Field>
      {draft.dueOn === null ? null : <Field label={t.dueOn}>{shortDate(draft.dueOn)}</Field>}
      <Field label={t.subject}>{draft.subject}</Field>
      {editing ? (
        <>
          <label style={{ display: "grid", gap: "var(--spacing-2xs)" }}>
            <Text as="span" variant="caption-sm" color="var(--content-tertiary)">
              {t.body}
            </Text>
            <textarea value={draft.template} rows={5} disabled={saving} aria-describedby={counterId} onChange={(event) => onBodyChange(event.target.value)} />
          </label>
          {/* #65/AC-5 Conta como a API: `template.length`, unidades UTF-16 do molde (não do texto renderizado). */}
          <Text as="p" variant="caption-sm" color="var(--content-tertiary)" id={counterId}>
            {t.counter(draft.template.length, MAX_FOLLOW_UP_TEMPLATE)}
          </Text>
          <Text as="p" variant="caption-sm" color="var(--content-tertiary)">
            {t.keepMarkers}
          </Text>
          {saveFailure ? (
            // #59/AC-2 O 422 mantém a edição aberta com a mensagem fixa: nunca o texto nem o corpo da resposta do servidor.
            <div role="alert">
              <Text as="p" variant="body-base">
                {t.saveFailed[saveFailure]}
              </Text>
            </div>
          ) : null}
        </>
      ) : (
        <Field label={t.body} keepLineBreaks>
          {draft.body}
        </Field>
      )}
      <Field label={t.attachment}>{draft.attachmentName}</Field>
      {busy ? (
        <div role="status">
          <Text as="p" variant="body-base">
            {t.sending}
          </Text>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
        {phase === "failed" ? (
          <Button variant="fill" size="base" onClick={onRetry}>
            {t.retry}
          </Button>
        ) : (
          // #59/AC-3 Editando, o envio espera: o texto que sai é o que o servidor guarda, e o da tela ainda não foi salvo.
          <Button variant="fill" size="base" onClick={onSend} disabled={busy || editing}>
            {t.send}
          </Button>
        )}
        {editing ? (
          <>
            <Button variant="fill" size="base" onClick={onSave} disabled={saving}>
              {saving ? t.saving : t.save}
            </Button>
            <Button variant="outline" size="base" onClick={onCancelEdit} disabled={saving}>
              {t.cancelEdit}
            </Button>
          </>
        ) : null}
        {editing || onEdit === undefined ? null : (
          <Button variant="outline" size="base" onClick={onEdit} disabled={busy}>
            {t.edit}
          </Button>
        )}
        <Button variant="outline" size="base" onClick={onDiscard} disabled={busy || saving}>
          {t.discard}
        </Button>
      </div>
    </section>
  );
}
