/**
 * #3 O bloco "Pedido ao fornecedor" da gaveta da proposta decidida, um estado do wireframe por vez
 * (artifacts/wireframe-pedido-ao-fornecedor/index.html). Só apresentação: o estado e o que a pessoa
 * lê entram por props, as ações saem por callbacks. Buscar, guardar estado e ligar na gaveta são da #16 e da #17.
 * Os tipos da visão são o que o bloco aceita: o `SupplierRequestDto` do fio (web/src/api/contract.ts, #17) cabe neles.
 */
import type { JSX, ReactNode } from "react";
import { Alert, Button, Text } from "barte-design-system";
import { AiSourceBadge, Panel } from "@barte-ai-services/barte-ui-kit";
import { texts } from "../texts";

const t = texts.supplierRequest;

/** #17 Um valor em reais já formatado, como a API o entrega. */
export interface SupplierRequestMoney {
  text: string;
}

export interface SupplierRequestNoteLine {
  description: string;
  quantity: string;
  unitPrice: SupplierRequestMoney;
  total: SupplierRequestMoney;
}

/** #3 A nota de devolução. Ausente nos pedidos só de e-mail (cancelamento, pedido, cadastro). */
export interface SupplierRequestNote {
  /** #17 O ND-n emitido; nulo antes da emissão. */
  number: string | null;
  /** #17 O código do fornecedor e a nota de referência, como a API os traz. */
  supplier?: string;
  reference?: string;
  lines: readonly SupplierRequestNoteLine[];
  total: SupplierRequestMoney;
}

export interface SupplierRequestEmail {
  to: string;
  /** #17 Dia no formato AAAA-MM-DD. */
  dueOn: string;
  subject: string;
  /** #17 O texto renderizado, o que a pessoa lê. */
  body: string;
  /** #17/AC-6 O molde com os `{{chave}}`: a edição abre com ele, e o PATCH o reenvia. */
  template: string;
}

export interface SupplierRequestAttachment {
  name: string;
  url: string;
}

interface WithContent {
  returnNote?: SupplierRequestNote;
  email: SupplierRequestEmail;
  attachment?: SupplierRequestAttachment;
}

/** #3 Os estados do pedido que a gaveta desenha; o 10 (sem pedido) é `request` nulo. */
export type SupplierRequestView =
  | { status: "writing" }
  | ({ status: "draft" } & WithContent)
  | ({ status: "editing" } & WithContent)
  | ({ status: "sent"; sentBy: string | null; sentAt: string | null } & WithContent)
  | ({ status: "send_failed"; failure: string } & WithContent)
  | { status: "discarded"; discardedAt: string | null; discardedBy?: string | null }
  | { status: "failed"; failure: string };

/** #3 A ação em andamento: trava os botões e troca o texto do principal. */
export type SupplierRequestPending = "send" | "discard" | "save" | "resend" | "redo";

export interface SupplierRequestBlockProps {
  /** #3/AC-1 Nulo: a proposta não tem pedido, e o bloco não existe. */
  request: SupplierRequestView | null;
  /** #3/AC-4 Quem está na gaveta; "por você" quando foi essa pessoa. */
  viewer: string;
  pending?: SupplierRequestPending;
  /** (#16) A mensagem da ação recusada, já em português para quem decide. */
  error?: string;
  /** #3/AC-6 O texto em edição, no estado `editing`. */
  draftText?: string;
  onSend: () => void;
  onDiscard: () => void;
  onEdit: () => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onResend: () => void;
  onRedo: () => void;
  /** #3/AC-9 A carga falhou: o alerta ocupa o lugar do bloco, e "Tentar de novo" chama `onReload`. */
  loadFailed?: boolean;
  reloading?: boolean;
  onReload: () => void;
  onDraftTextChange: (text: string) => void;
}

/** #3 "2026-11-18" vira "18/11", sem passar por fuso. */
const dayMonth = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** #3 "2026-11-15T13:40:00Z" vira "10h40" na hora de quem olha; sem carimbo (#17), sem hora. */
function clock(instant: string | null): string | null {
  if (instant === null) return null;
  const at = new Date(instant);
  return `${String(at.getHours()).padStart(2, "0")}h${String(at.getMinutes()).padStart(2, "0")}`;
}

export function SupplierRequestBlock(props: SupplierRequestBlockProps): JSX.Element | null {
  const { request, pending, error } = props;
  if (props.loadFailed) return <LoadFailed reloading={props.reloading === true} onReload={props.onReload} />;
  if (!request) return null;
  return (
    <div aria-busy={pending ? true : undefined}>
      <Panel title={t.title} aside={<AiSourceBadge source="ai" label={t.badge} size="sm" />} size="sm">
        {error ? <Alert variant="error" title={error} showCloseButton={false} /> : null}
        <State {...props} request={request} />
      </Panel>
    </div>
  );
}

/** #3/AC-9 No lugar do bloco, sem título nem selo (não há pedido carregado); a mensagem é fixa, nunca a do erro. */
function LoadFailed({ reloading, onReload }: { reloading: boolean; onReload: () => void }): JSX.Element {
  return (
    <div>
      <Alert variant="error" title={t.loadFailed.title} showCloseButton={false} />
      <PrimaryAction label={reloading ? t.loadFailed.loading : t.loadFailed.retry} onClick={onReload} pending={reloading} />
    </div>
  );
}

function State(props: SupplierRequestBlockProps & { request: SupplierRequestView }): JSX.Element {
  const { request } = props;
  switch (request.status) {
    case "writing":
      return <Text variant="body-sm">{t.writing}</Text>;
    case "draft":
    case "editing":
      return <Draft {...props} request={request} />;
    case "sent":
      return <Sent request={request} viewer={props.viewer} />;
    case "send_failed":
      return <SendFailed {...props} request={request} />;
    case "discarded":
      return <Discarded {...props} request={request} />;
    case "failed":
      return <Failed {...props} request={request} />;
  }
}

/** #17 Sem quem agiu (nulo), a frase não diz por quem; o resto segue "por você" ou "por fulano". */
const actor = (who: string | null | undefined, viewer: string): string | null => {
  if (who === null) return null;
  return who === undefined || who === viewer ? t.byYou : t.by(who);
};

/** #17 O texto fixo de um código da API; um código que a tela não conhece vira a frase genérica, nunca o código. */
const reasonOf = (reasons: Readonly<Record<string, string>>, code: string, other: string): string => (Object.hasOwn(reasons, code) ? (reasons[code] ?? other) : other);

function Draft(props: SupplierRequestBlockProps & { request: Extract<SupplierRequestView, { status: "draft" | "editing" }> }): JSX.Element {
  const { request, pending, draftText } = props;
  const editing = request.status === "editing";
  const busy = pending !== undefined;
  const sendLabel = request.returnNote ? "sendWithNote" : "sendEmailOnly";
  return (
    <>
      {request.returnNote ? <NoteView note={request.returnNote} locked={editing} /> : null}
      <EmailView email={request.email} locked={editing} text={editing ? (draftText ?? request.email.template) : undefined} onText={props.onDraftTextChange} />
      {editing ? null : <AttachmentHint attachment={request.attachment} hasNote={request.returnNote !== undefined} />}
      <div style={{ display: "flex", gap: "var(--spacing-md)" }}>
        {editing ? (
          <>
            <Button variant="outline" onClick={props.onCancelEdit} disabled={busy}>{t.actions.cancelEdit}</Button>
            <Button onClick={props.onSave} disabled={busy}>{pending === "save" ? t.pending.save : t.actions.save}</Button>
          </>
        ) : null}
        <Button variant="outline" onClick={props.onDiscard} disabled={busy || editing}>
          {pending === "discard" ? t.pending.discard : t.actions.discard}
        </Button>
        {editing ? null : (
          <Button variant="outline" onClick={props.onEdit} disabled={busy}>{t.actions.edit}</Button>
        )}
        <Button onClick={props.onSend} disabled={busy || editing}>
          {pending === "send" ? t.pending[sendLabel] : t.actions[sendLabel]}
        </Button>
      </div>
    </>
  );
}

/**
 * #65/AC-6 A dica do anexo no rascunho, como o wireframe #156 a desenha: "📎 nota-devolucao-ND-0012.pdf (anexa ao enviar)".
 * #65 O nome real vem do dado quando ele existe; antes da emissão a API não o traz (o PDF nasce com o número da nota), e vale o texto do wireframe. Pedido só de e-mail não tem anexo.
 */
function AttachmentHint({ attachment, hasNote }: { attachment?: SupplierRequestAttachment; hasNote: boolean }): JSX.Element | null {
  if (!attachment && !hasNote) return null;
  return (
    <Text variant="body-xs">
      <span aria-hidden="true">📎 </span>
      {attachment ? t.attachment(attachment.name) : t.attachmentPending}
    </Text>
  );
}

function NoteView({ note, locked }: { note: SupplierRequestNote; locked: boolean }): JSX.Element {
  return (
    <div>
      <Text as="p" variant="body-sm">
        {locked ? `${t.note.lockedTitle} · ${t.note.locked}` : t.note.title}
      </Text>
      {note.supplier && note.reference ? <Text as="p" variant="body-xs">{t.noteFor(note.supplier, note.reference)}</Text> : null}
      <ul>
        {note.lines.map((line, i) => (
          <li key={`${line.description}-${i}`}>
            <span>{line.description}</span> <span>{t.noteLine(line.quantity, line.unitPrice.text)}</span> <span>{line.total.text}</span>
          </li>
        ))}
      </ul>
      <p>
        <span>{t.note.total}</span> <strong>{note.total.text}</strong>
      </p>
    </div>
  );
}

function EmailView({ email, locked, text, onText }: { email: SupplierRequestEmail; locked: boolean; text?: string; onText: (text: string) => void }): JSX.Element {
  return (
    <div>
      <Text as="p" variant="body-sm">{t.email.title}</Text>
      {locked ? <Text as="p" variant="body-xs">{t.email.lockedFields}</Text> : <Text as="p" variant="body-xs">{t.email.toAndDue(email.to, dayMonth(email.dueOn))}</Text>}
      <p>
        <strong>{t.email.subject}</strong> {email.subject}
      </p>
      {text === undefined ? (
        <div style={{ whiteSpace: "pre-line" }}>{email.body}</div>
      ) : (
        <>
          <textarea aria-label={t.email.bodyLabel} value={text} rows={6} onChange={(e) => onText(e.target.value)} style={{ width: "100%" }} />
          <Text as="p" variant="body-xs">{t.email.checkedOnSave}</Text>
          <Text as="p" variant="body-xs">{t.email.keepMarkers}</Text>
        </>
      )}
    </div>
  );
}

function AttachmentLink({ attachment }: { attachment: SupplierRequestAttachment }): JSX.Element {
  // #3/AC-4 A URL vem da API: só caminho do próprio site ou http(s) vira link; qualquer outro esquema fica como texto.
  const safe = /^(\/(?!\/)|https?:\/\/)/.test(attachment.url);
  if (!safe) return <Text variant="body-xs">{attachment.name}</Text>;
  return (
    <a href={attachment.url} target="_blank" rel="noopener noreferrer">
      {attachment.name}
    </a>
  );
}

function Sent({ request, viewer }: { request: Extract<SupplierRequestView, { status: "sent" }>; viewer: string }): JSX.Element {
  const stamp = t.stamp(actor(request.sentBy, viewer), clock(request.sentAt));
  const until = dayMonth(request.email.dueOn);
  const line = request.returnNote?.number ? t.sentWithNote(request.returnNote.number, stamp, until) : t.sentEmailOnly(stamp, until);
  return (
    <>
      <Text variant="body-sm">{line}</Text>
      {request.attachment ? <AttachmentLink attachment={request.attachment} /> : null}
      <details>
        <summary>{t.seeSent}</summary>
        {request.returnNote ? <NoteView note={request.returnNote} locked={false} /> : null}
        <EmailView email={request.email} locked={false} onText={() => undefined} />
      </details>
    </>
  );
}

function PrimaryAction({ label, onClick, pending }: { label: ReactNode; onClick: () => void; pending: boolean }): JSX.Element {
  return <Button onClick={onClick} disabled={pending}>{label}</Button>;
}

function SendFailed(props: SupplierRequestBlockProps & { request: Extract<SupplierRequestView, { status: "send_failed" }> }): JSX.Element {
  const { request, pending } = props;
  const reason = reasonOf(t.sendFailureReasons, request.failure, t.sendFailureOther);
  const message = request.returnNote?.number ? t.sendFailedWithNote(request.returnNote.number, reason) : t.sendFailedEmailOnly(reason);
  return (
    <>
      <Alert variant="error" title={message} showCloseButton={false} />
      {/* #65/AC-4 Com a nota já emitida, diz o que tentar de novo e descartar fazem com ela. */}
      {request.returnNote?.number ? <Text variant="body-xs">{t.sendFailedNoteKept}</Text> : null}
      {request.attachment ? <AttachmentLink attachment={request.attachment} /> : null}
      <PrimaryAction label={pending === "resend" ? t.pending.resend : t.actions.resend} onClick={props.onResend} pending={pending !== undefined} />
    </>
  );
}

function Discarded(props: Pick<SupplierRequestBlockProps, "viewer" | "pending" | "onRedo"> & { request: Extract<SupplierRequestView, { status: "discarded" }> }): JSX.Element {
  const { request, pending } = props;
  return (
    <>
      <Text variant="body-sm">{t.discarded(t.stamp(actor(request.discardedBy, props.viewer), clock(request.discardedAt)))}</Text>
      <PrimaryAction label={pending === "redo" ? t.pending.redo : t.actions.redo} onClick={props.onRedo} pending={pending !== undefined} />
    </>
  );
}

function Failed(props: Pick<SupplierRequestBlockProps, "pending" | "onRedo"> & { request: Extract<SupplierRequestView, { status: "failed" }> }): JSX.Element {
  const { request, pending } = props;
  return (
    <>
      <Alert variant="error" title={t.notPrepared(reasonOf(t.notPreparedReasons, request.failure, t.notPreparedOther))} showCloseButton={false} />
      <PrimaryAction label={pending === "redo" ? t.pending.redo : t.actions.redo} onClick={props.onRedo} pending={pending !== undefined} />
    </>
  );
}
