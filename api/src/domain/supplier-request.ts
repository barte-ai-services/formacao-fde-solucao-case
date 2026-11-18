import { addBusinessDays, formatBrazilianDate } from './calendar.js';
import { factKey, renderText, textChecks, type Fact, type FactCatalog } from './dossier.js';
import { DomainError, InvalidTransitionError } from './errors.js';
import type { InvoiceView } from './invoice.js';
import { Money } from './money.js';
import type { IssuedReturnNote, ReturnNoteDraft } from './return-note-document.js';

// #156: o pedido ao fornecedor (#156): o rascunho que o agente de tratativa monta, a pessoa revisa e o envio
// #156: fecha. A nota (itens e totais) é da regra; o Claude escreve só assunto, corpo e a lista do que
// #156: pedimos, e todo número desses textos é um {{chave}} do catálogo de fatos (contrato de dossier.ts).

export type RequestType = 'return_note'; // #156
export type RequestStatus = 'draft' | 'sent' | 'send_failed' | 'discarded'; // #156

/** #156: o prazo padrão de resposta do fornecedor, em dias úteis depois do rascunho. */
export const DEFAULT_DUE_BUSINESS_DAYS = 3;

/** #156: aberto é `draft`, `sent` e `send_failed`; só `discarded` fecha o pedido. */
export const isOpenRequestStatus = (status: RequestStatus): boolean => status !== 'discarded';

/** #156: o que se precisa saber de um pedido para dizer se a nota de origem já tem um aberto. */
export type RequestRef = {
  readonly invoiceAccessKey: string;
  readonly requestType: RequestType;
  readonly status: RequestStatus;
};

/** #156: uma nota de origem não tem dois pedidos abertos do mesmo tipo. */
export const hasOpenRequest = (existing: readonly RequestRef[], invoiceAccessKey: string, requestType: RequestType): boolean =>
  existing.some((r) => r.invoiceAccessKey === invoiceAccessKey && r.requestType === requestType && isOpenRequestStatus(r.status));

/** #156: o catálogo de fatos do pedido: quantidade e valor de cada linha, o total, o número da nota e o prazo. */
export function buildSupplierRequestFacts(note: ReturnNoteDraft, invoice: Pick<InvoiceView, 'number'>, dueOn: string): FactCatalog {
  const facts: Record<string, Fact> = {};
  const ids = new Set<string>([note.referencedAccessKey, note.supplierId, note.destination]);
  const put = (key: string, label: string, value: string, source: Fact['source']): void => {
    facts[key] = Object.freeze({ label, value, source });
  };
  put(factKey.invoiceNumber(), 'Número da nota de origem', invoice.number, 'invoice');
  put(factKey.returnTotal(), 'Valor total da devolução', Money.fromReais(note.total).toString(), 'return_note');
  put(factKey.dueDate(), 'Prazo de resposta do fornecedor', formatBrazilianDate(dueOn), 'return_note');
  for (const item of note.items) {
    const code = item.supplierCode;
    put(factKey.returnItem(code, 'quantidade'), `Quantidade devolvida de ${item.description}`, `${item.quantity} ${item.unit}`, 'return_note');
    put(factKey.returnItem(code, 'valor'), `Valor devolvido de ${item.description}`, Money.fromReais(item.value).toString(), 'return_note');
    ids.add(code);
    if (item.sku !== null) ids.add(item.sku);
  }
  return Object.freeze({ facts: Object.freeze(facts), identifiers: Object.freeze([...ids]) });
}

/** #156: o texto que o Claude escreve; os números aparecem só como {{chave}}. */
export type SupplierRequestText = {
  readonly subject: string;
  readonly body: string;
  readonly asks: readonly string[];
};

export type TextField = 'subject' | 'body' | 'asks';

/** #156: por que o texto foi recusado e em que campo; `invalid_shape` é texto que nem tem a forma pedida. */
export type RequestTextRejection = {
  readonly ok: false;
  readonly reason: 'number_mismatch' | 'invalid_shape';
  readonly field: TextField;
};

export type RequestTextValidation =
  | { readonly ok: true; readonly text: SupplierRequestText; readonly rendered: SupplierRequestText }
  | RequestTextRejection;

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isText);
const FIELDS: readonly TextField[] = ['subject', 'body', 'asks'];

function rejection(reason: RequestTextRejection['reason'], field: TextField): RequestTextRejection {
  return Object.freeze({ ok: false, reason, field });
}

/** #156: um campo confere quando todo marcador está no catálogo e nenhum número sobra fora dele. */
const fieldChecks = (texts: readonly string[], catalog: FactCatalog): boolean =>
  texts.every((t) => textChecks(t, catalog, new Set(catalog.identifiers)));

/** #156: confere um texto cru (o do Claude, ou o de uma pessoa) contra o catálogo do pedido. */
export function validateRequestText(raw: unknown, catalog: FactCatalog): RequestTextValidation {
  if (typeof raw !== 'object' || raw === null) return rejection('invalid_shape', 'subject');
  const record = raw as Record<string, unknown>; // #156: só lida abaixo, campo a campo, com guarda de tipo
  const { subject, body, asks } = record;
  if (!isText(subject)) return rejection('invalid_shape', 'subject');
  if (!isText(body)) return rejection('invalid_shape', 'body');
  if (!isTexts(asks)) return rejection('invalid_shape', 'asks');
  for (const field of FIELDS) {
    const texts = field === 'asks' ? asks : [field === 'body' ? body : subject];
    if (!fieldChecks(texts, catalog)) return rejection('number_mismatch', field);
  }
  const text: SupplierRequestText = Object.freeze({ subject, body, asks: Object.freeze([...asks]) });
  const rendered: SupplierRequestText = Object.freeze({
    subject: renderText(subject, catalog),
    body: renderText(body, catalog),
    asks: Object.freeze(asks.map((a) => renderText(a, catalog))),
  });
  return Object.freeze({ ok: true, text, rendered });
}

type DraftProps = {
  /** #156: a identidade do pedido, dada por quem o persiste; o domínio não a gera. */
  readonly id: number;
  readonly invoiceAccessKey: string;
  readonly note: ReturnNoteDraft;
  readonly text: SupplierRequestText;
  /** #156: o dia do rascunho, AAAA-MM-DD; o prazo conta daqui. */
  readonly draftedOn: string;
};

type RejectedProps = Omit<DraftProps, 'text'> & { readonly rejection: RequestTextRejection };

const sameNote = (a: ReturnNoteDraft, b: ReturnNoteDraft): boolean =>
  a.referencedAccessKey === b.referencedAccessKey &&
  a.supplierId === b.supplierId &&
  a.destination === b.destination &&
  a.total === b.total &&
  JSON.stringify(a.items) === JSON.stringify(b.items);

/** O pedido ao fornecedor (#156): raiz do agregado do ciclo draft, sent, send_failed e discarded. */
export class SupplierRequest {
  readonly id: number;
  readonly requestType: RequestType = 'return_note';
  readonly invoiceAccessKey: string;
  /** #156: a nota montada pela regra; congelada, nenhuma edição a alcança. */
  readonly note: ReturnNoteDraft;
  readonly subject: string;
  readonly asks: readonly string[];
  readonly dueOn: string;
  private currentBody: string;
  private currentStatus: RequestStatus;
  private reason: string | null;
  private failureReason: string | null = null;
  private issued: IssuedReturnNote | null = null;

  private constructor(props: DraftProps, status: RequestStatus, reason: string | null) {
    this.id = props.id;
    this.invoiceAccessKey = props.invoiceAccessKey;
    this.note = props.note;
    this.subject = props.text.subject;
    this.asks = Object.freeze([...props.text.asks]);
    this.currentBody = props.text.body;
    this.dueOn = addBusinessDays(props.draftedOn, DEFAULT_DUE_BUSINESS_DAYS);
    this.currentStatus = status;
    this.reason = reason;
  }

  /** #156: o rascunho; `text` é o que `validateRequestText` aceitou. */
  static draft(props: DraftProps): SupplierRequest {
    return new SupplierRequest(props, 'draft', null);
  }

  /** #156: o texto do Claude foi recusado: o pedido nasce descartado, com o motivo e o campo. */
  static rejected(props: RejectedProps): SupplierRequest {
    const { rejection: why, ...rest } = props;
    const reason = `${why.reason}: ${why.field}`;
    return new SupplierRequest({ ...rest, text: { subject: '', body: '', asks: [] } }, 'discarded', reason);
  }

  get status(): RequestStatus {
    return this.currentStatus;
  }

  get body(): string {
    return this.currentBody;
  }

  get discardReason(): string | null {
    return this.reason;
  }

  /** #156: a nota emitida, ou null enquanto não houve emissão; quem reenvia emite só se for null. */
  get issuedNote(): IssuedReturnNote | null {
    return this.issued;
  }

  /** #156: o motivo da última falha do envio, ou null enquanto nenhuma houve; não é o do descarte. */
  get sendFailureReason(): string | null {
    return this.failureReason;
  }

  get isOpen(): boolean {
    return isOpenRequestStatus(this.currentStatus);
  }

  // #156: a nota é registrada uma vez só, e só a partir do rascunho; o reenvio reusa a que já foi registrada.
  // #156: o domínio não proíbe `sent` nem `send_failed` sem nota: quem emite antes de enviar é o
  // #156: caso de uso de envio, quando o pedido leva nota de devolução.
  recordIssuance(issued: IssuedReturnNote): void {
    this.assertFrom(['draft'], 'registrar a emissão');
    if (this.issued !== null) throw new DomainError('Pedido: a nota já foi emitida; reenviar não emite outra');
    if (!sameNote(this.note, issued)) throw new DomainError('Pedido: a nota emitida não é a nota deste pedido');
    this.issued = issued;
  }

  markSent(): void {
    this.assertFrom(['draft', 'send_failed'], 'enviar');
    this.currentStatus = 'sent';
  }

  /** #156: cada falha do envio registra o motivo; o reenvio que falha de novo troca o motivo. */
  markSendFailed(reason: string): void {
    this.assertFrom(['draft', 'send_failed'], 'registrar a falha do envio');
    if (reason.trim() === '') throw new DomainError('Pedido: a falha do envio registra o motivo');
    this.currentStatus = 'send_failed';
    this.failureReason = reason;
  }

  discard(reason: string): void {
    this.assertFrom(['draft'], 'descartar');
    if (reason.trim() === '') throw new DomainError('Pedido: o descarte registra o motivo');
    this.currentStatus = 'discarded';
    this.reason = reason;
  }

  /** #156: só o corpo de um rascunho muda, revalidado contra o catálogo; recusado, fica o anterior. */
  editBody(body: string, catalog: FactCatalog): RequestTextValidation {
    this.assertFrom(['draft'], 'editar o corpo');
    const result = validateRequestText({ subject: this.subject, body, asks: this.asks }, catalog);
    if (result.ok) this.currentBody = body;
    return result;
  }

  private assertFrom(allowed: readonly RequestStatus[], action: string): void {
    if (!allowed.includes(this.currentStatus)) {
      throw new InvalidTransitionError('SupplierRequest', this.currentStatus, action);
    }
  }
}
