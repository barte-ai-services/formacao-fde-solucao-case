import { addBusinessDays, formatBrazilianDate, parseIsoDate } from './calendar.js';
import { factKey, textChecks, type FactCatalog } from './dossier.js';
import { DEFAULT_DUE_BUSINESS_DAYS, type RequestStatus, type SupplierRequestText } from './supplier-request.js';

// #157: a leitura da resposta do fornecedor (#157). O Claude lê a resposta e devolve um objeto; a regra
// #157: confere esse objeto, corrige o próximo passo e diz em que filtro da lista cada pedido cai.
// #157: nada aqui lê relógio nem banco: as datas chegam como AAAA-MM-DD.

export type ReplyOutcome = 'fulfilled' | 'partially_fulfilled' | 'refused' | 'needs_information' | 'no_reply'; // #157
export type NextStep = 'close' | 'confirm_document' | 'answer_supplier' | 'follow_up'; // #157

/** #157: as listas de valores, que o teste percorre para provar que toda leitura cai em um filtro. */
export const REPLY_OUTCOMES: readonly ReplyOutcome[] = ['fulfilled', 'partially_fulfilled', 'refused', 'needs_information', 'no_reply'];
export const NEXT_STEPS: readonly NextStep[] = ['close', 'confirm_document', 'answer_supplier', 'follow_up'];

/**
 * #157: a leitura carrega só dados da leitura. Não há campo de decisão, de título nem de valor em
 * risco: uma ordem escondida na resposta só chega a `injectionFlag`, e o que o modelo devolver além
 * destes campos é descartado na validação.
 */
export type SupplierReading = {
  readonly replyOutcome: ReplyOutcome;
  readonly fulfilledAsks: readonly string[];
  readonly supplierDocument: string | null;
  readonly summary: string;
  readonly nextStep: NextStep;
  readonly injectionFlag: string | null;
};

/** #157: o campo do objeto cru do modelo, com o nome que ele usa (snake_case). */
export type ReadingField = 'reply_outcome' | 'fulfilled_asks' | 'supplier_document' | 'summary' | 'next_step' | 'injection_flag';

export type ReadingRejection = {
  readonly ok: false;
  readonly reason: 'invalid_shape' | 'unknown_ask' | 'number_mismatch' | 'no_reply_for_reply' | 'injection_not_in_reply' | 'document_not_in_reply';
  readonly field: ReadingField;
};

export type ReadingValidation = { readonly ok: true; readonly reading: SupplierReading } | ReadingRejection;

/** #157: contra o que a leitura é conferida: o que pedimos, o texto da resposta e o catálogo de fatos do pedido. */
export type ReadingContext = {
  /** #157: os itens do que pedimos, como o modelo os viu; `fulfilled_asks` só traz itens desta lista. */
  readonly asks: readonly string[];
  readonly replyText: string;
  readonly catalog: FactCatalog;
};

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isOutcome = (v: unknown): v is ReplyOutcome => REPLY_OUTCOMES.some((o) => o === v);
const isNextStep = (v: unknown): v is NextStep => NEXT_STEPS.some((n) => n === v);
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);

const rejection = (reason: ReadingRejection['reason'], field: ReadingField): ReadingRejection =>
  Object.freeze({ ok: false, reason, field });

const MARKER = /\{\{[^}]*\}\}/; // #157: marcador {{chave}}, que o summary não tem

const bareToken = (token: string): string => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

const tokensOf = (text: string): string[] => text.split(/[\s/]+/).map(bareToken).filter((t) => t !== '');

const MAX_DOCUMENT_TOKENS = 2; // #157: "NF-D 881" tem dois tokens; mais que isso já é frase

/** #157: o documento está na resposta por palavras inteiras: a sequência dele de tokens aparece seguida na da resposta. */
function documentInReply(document: string, replyText: string): boolean {
  const wanted = tokensOf(document);
  if (wanted.length === 0) return false;
  const reply = tokensOf(replyText);
  for (let i = 0; i + wanted.length <= reply.length; i++) {
    if (wanted.every((t, j) => reply[i + j] === t)) return true;
  }
  return false;
}

/**
 * #157: o summary é texto corrido, sem {{chave}} (`validateReading` recusa o marcador, porque o
 * summary não é renderizado): ele conta o que o fornecedor disse, e o que o fornecedor disse (o número
 * do documento dele) não está no catálogo. Por isso cada número do summary tem de ser um valor de fato
 * do catálogo, um identificador do pedido ou o `supplier_document` citado, que está na resposta; o
 * `supplier_document` é só o identificador do documento (no máximo dois tokens, como "NF-D 881"), e
 * `validateReading` recusa o que passar disso, para que o campo não carregue uma frase da resposta e
 * libere os números dela;
 * `textChecks` (o mesmo contrato do texto da #156) faz a conferência, e recusa também o número por extenso.
 */
function allowedNumbers(catalog: FactCatalog, supplierDocument: string | null): ReadonlySet<string> {
  const allowed = new Set<string>(catalog.identifiers);
  const values = [...Object.values(catalog.facts).map((f) => f.value), ...(supplierDocument === null ? [] : [supplierDocument])];
  for (const value of values) {
    allowed.add(value);
    for (const token of value.split(/[\s/]+/)) allowed.add(bareToken(token));
  }
  return allowed;
}

/**
 * #157: "atendeu" com documento citado nunca fecha sozinho: o próximo passo é `confirm_document`,
 * diga o modelo o que disser. Só `fulfilled` fecha: o que foi recusado, parcial ou pede informação
 * pede resposta nossa, nunca `close`.
 */
export function guardNextStep(outcome: ReplyOutcome, supplierDocument: string | null, nextStep: NextStep): NextStep {
  if (outcome === 'fulfilled' && supplierDocument !== null) return 'confirm_document';
  if (nextStep === 'close' && outcome !== 'fulfilled') return 'answer_supplier';
  return nextStep;
}

/** #157, #157: confere a saída crua do modelo contra o pedido e a resposta; só os campos da leitura passam. */
export function validateReading(raw: unknown, ctx: ReadingContext): ReadingValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return rejection('invalid_shape', 'reply_outcome');
  const record = raw as Record<string, unknown>; // #157: só lida abaixo, campo a campo, com guarda de tipo
  const { reply_outcome, fulfilled_asks, supplier_document, summary, next_step, injection_flag } = record;
  if (!isOutcome(reply_outcome)) return rejection('invalid_shape', 'reply_outcome');
  // #157: a resposta existe, então o modelo não pode dizer que não houve; `no_reply` é só do prazo.
  if (reply_outcome === 'no_reply') return rejection('no_reply_for_reply', 'reply_outcome');
  if (!isTexts(fulfilled_asks)) return rejection('invalid_shape', 'fulfilled_asks');
  if (!fulfilled_asks.every((a) => ctx.asks.includes(a))) return rejection('unknown_ask', 'fulfilled_asks');
  if (supplier_document !== null && !isText(supplier_document)) return rejection('invalid_shape', 'supplier_document');
  const document = supplier_document === null ? null : supplier_document.trim();
  // #157: o documento é só o identificador, no máximo dois tokens; uma frase inteira liberaria os números dela no summary.
  if (document !== null && tokensOf(document).length > MAX_DOCUMENT_TOKENS) return rejection('invalid_shape', 'supplier_document');
  // #157: o documento é palavra do modelo, e libera número no summary: tem de estar na resposta, como o injection_flag.
  if (document !== null && !documentInReply(document, ctx.replyText)) return rejection('document_not_in_reply', 'supplier_document');
  if (!isText(summary) || MARKER.test(summary)) return rejection('invalid_shape', 'summary');
  if (!textChecks(summary, ctx.catalog, allowedNumbers(ctx.catalog, document))) return rejection('number_mismatch', 'summary');
  if (!isNextStep(next_step)) return rejection('invalid_shape', 'next_step');
  if (injection_flag !== null && !isText(injection_flag)) return rejection('invalid_shape', 'injection_flag');
  // #157: o trecho tem de estar na resposta, palavra por palavra. Um trecho que o modelo inventou
  // #157: recusa a leitura, em vez de seguir sem o aviso: um sinal falso de segurança não vale.
  if (injection_flag !== null && !ctx.replyText.includes(injection_flag)) return rejection('injection_not_in_reply', 'injection_flag');
  return Object.freeze({
    ok: true,
    reading: Object.freeze({
      replyOutcome: reply_outcome,
      fulfilledAsks: Object.freeze([...fulfilled_asks]),
      supplierDocument: document,
      summary,
      nextStep: guardNextStep(reply_outcome, document, next_step),
      injectionFlag: injection_flag,
    }),
  });
}

/** #157: o que se precisa saber de um pedido para o prazo e o filtro. */
export type RequestDeadline = { readonly status: RequestStatus; readonly dueOn: string };

const isPastDue = (dueOn: string, today: string): boolean => parseIsoDate(today).getTime() > parseIsoDate(dueOn).getTime();

/** #157: a leitura do pedido que passou do prazo sem resposta; sem número, para a cobrança sair do catálogo. */
const OVERDUE_READING: SupplierReading = Object.freeze({
  replyOutcome: 'no_reply',
  fulfilledAsks: Object.freeze([]),
  supplierDocument: null,
  summary: 'O fornecedor não respondeu até o prazo.',
  nextStep: 'follow_up',
  injectionFlag: null,
});

/**
 * #157: um pedido `sent` sem leitura, com `today` depois de `dueOn`, é `no_reply` com `follow_up`.
 * No dia do prazo ainda está no prazo. Pedido com leitura ou que não foi enviado: null.
 */
export function overdueReading(request: RequestDeadline, reading: SupplierReading | null, today: string): SupplierReading | null {
  const pastDue = isPastDue(request.dueOn, today);
  return request.status === 'sent' && reading === null && pastDue ? OVERDUE_READING : null;
}

/**
 * #157 (como a followUpDraftFor da PR Djegao/grupo-5-slucao#40): a leitura que pede a cobrança é a que não respondeu (`no_reply`) e as respostas
 * `partially_fulfilled` e `needs_information` cujo próximo passo é `follow_up`. Outro próximo passo é resposta nossa, não cobrança.
 */
export function owesFollowUp(reading: SupplierReading | null): boolean {
  if (reading === null) return false;
  if (reading.replyOutcome === 'no_reply') return true;
  const partial = reading.replyOutcome === 'partially_fulfilled' || reading.replyOutcome === 'needs_information';
  return partial && reading.nextStep === 'follow_up';
}

/**
 * #157: a cobrança é devida hoje: o pedido está `sent`, a leitura a pede e, nas respostas (`partially_fulfilled`,
 * `needs_information`), o prazo do pedido já passou (no dia do prazo ainda está no prazo). O `no_reply` só nasce depois do prazo.
 */
export function followUpDue(request: RequestDeadline, reading: SupplierReading | null, today: string): boolean {
  if (request.status !== 'sent' || reading === null || !owesFollowUp(reading)) return false;
  return reading.replyOutcome === 'no_reply' || isPastDue(request.dueOn, today);
}

/** #157: os filtros da lista "Pedidos ao fornecedor"; o rótulo que a pessoa lê mora fora do domínio. */
export type RequestFilter = 'awaiting' | 'answered' | 'needs_you' | 'overdue';

/**
 * #157 (ADR-005): a confirmação do documento que o fornecedor citou: o documento, quem confirmou (o e-mail do Access) e quando.
 * É um fato à parte da leitura: confirmar não muda a leitura, a decisão, o título nem o valor em risco (#157).
 */
export type DocumentConfirmation = { readonly document: string; readonly by: string; readonly at: Date };

/** #157: por que um pedido não se confirma: não está em `confirm_document`, ou o documento já foi confirmado. */
export type ConfirmRefusal = 'not_confirm_document' | 'already_confirmed';

/** #157: a leitura que pede a confirmação: atendeu (`fulfilled`), citou um documento e o próximo passo é `confirm_document`. */
const awaitsConfirmation = (reading: SupplierReading | null): reading is SupplierReading & { readonly supplierDocument: string } =>
  reading !== null && reading.replyOutcome === 'fulfilled' && reading.nextStep === 'confirm_document' && reading.supplierDocument !== null;

/**
 * #157: a confirmação que vale para a leitura atual: a mais recente do documento que ela cita (as gravadas chegam em ordem). Uma leitura nova com
 * outro documento deixa a confirmação velha para trás e pede outra; com o mesmo documento, a confirmação continua valendo. Sem a leitura que pede
 * confirmação (outro desfecho, outro próximo passo, sem documento), não há confirmação.
 */
export function confirmationOf(reading: SupplierReading | null, stored: readonly DocumentConfirmation[]): DocumentConfirmation | null {
  if (!awaitsConfirmation(reading)) return null;
  const ofDocument = stored.filter((c) => c.document === reading.supplierDocument);
  return ofDocument.at(-1) ?? null;
}

/** #157: o pedido enviado cuja leitura pede a confirmação e ainda não foi confirmada não tem recusa (null); senão, o motivo. */
export function confirmRefusal(request: RequestDeadline, reading: SupplierReading | null, stored: readonly DocumentConfirmation[]): ConfirmRefusal | null {
  if (request.status !== 'sent' || !awaitsConfirmation(reading)) return 'not_confirm_document';
  return confirmationOf(reading, stored) === null ? null : 'already_confirmed';
}

/**
 * #157: todo pedido enviado cai em um filtro só (o que não foi enviado, em nenhum). A ordem decide:
 * sem leitura, o prazo separa `awaiting` de `overdue`; `no_reply` é `overdue`; `fulfilled` com `close` é `answered`;
 * #157: `fulfilled` com `confirm_document` cujo documento a pessoa já confirmou também é `answered`; todo o resto
 * (inclusive o `confirm_document` ainda sem confirmação) precisa de uma pessoa.
 */
export function filterOf(
  request: RequestDeadline,
  reading: SupplierReading | null,
  today: string,
  confirmations: readonly DocumentConfirmation[] = [],
): RequestFilter | null {
  if (request.status !== 'sent') return null;
  if (reading === null) return isPastDue(request.dueOn, today) ? 'overdue' : 'awaiting';
  if (reading.replyOutcome === 'no_reply') return 'overdue';
  if (reading.replyOutcome === 'fulfilled' && reading.nextStep === 'close') return 'answered';
  return confirmationOf(reading, confirmations) === null ? 'needs_you' : 'answered';
}

/** #157: o que a regra precisa do pedido para montar a cobrança: o que pedimos (forma com {{chave}}) e o que o fornecedor já atendeu. */
export type FollowUpBasis = { readonly asks: readonly string[]; readonly fulfilledAsks: readonly string[] };

/** #157: o texto da cobrança (forma com {{chave}}) e o novo prazo, AAAA-MM-DD. */
export type FollowUpDraft = { readonly text: SupplierRequestText; readonly dueOn: string };

/**
 * #157: a cobrança montada pela regra, sem o Claude. #157: pede só o que o fornecedor ainda não atendeu (os `asks` fora
 * de `fulfilledAsks`; com tudo atendido, o que uma leitura parcial ou de pedido de informação pode listar, volta a pedir os itens do pedido, para o texto nunca ficar sem itens), cita a nota de origem
 * e traz o novo prazo, 3 dias úteis depois de `today`. #157: todo número do texto é um marcador {{chave}} do catálogo: o número
 * da nota (`nota.numero`) e o novo prazo (`cobranca.prazo`, que `withFollowUpDueDate` põe no catálogo); os itens vêm do pedido, que já os guarda assim.
 */
export function followUpDraftFor(basis: FollowUpBasis, today: string): FollowUpDraft {
  const open = basis.asks.filter((ask) => !basis.fulfilledAsks.includes(ask));
  const asks = open.length > 0 ? open : [...basis.asks];
  const body = [
    'Olá.',
    '',
    `Não recebemos a resposta ao nosso pedido sobre a nota {{${factKey.invoiceNumber()}}} dentro do prazo.`,
    `Pedimos, por favor, até {{${factKey.followUpDueDate()}}}:`,
    ...asks.map((ask) => `- ${ask}`),
    '',
    'Ficamos no aguardo.',
    '',
    'Obrigado,',
    'Contas a pagar · Já Chegou',
  ].join('\n');
  const text: SupplierRequestText = Object.freeze({
    subject: `Lembrete: pedido sobre a nota {{${factKey.invoiceNumber()}}}`,
    body,
    asks: Object.freeze(asks),
  });
  return Object.freeze({ text, dueOn: addBusinessDays(today, DEFAULT_DUE_BUSINESS_DAYS) });
}

/** #157: o catálogo do pedido com o novo prazo da cobrança, a data como o e-mail a escreve; o prazo original segue em `prazo`. */
export function withFollowUpDueDate(catalog: FactCatalog, dueOn: string): FactCatalog {
  const fact = Object.freeze({ label: 'Novo prazo de resposta do fornecedor', value: formatBrazilianDate(dueOn), source: 'return_note' as const });
  return Object.freeze({ facts: Object.freeze({ ...catalog.facts, [factKey.followUpDueDate()]: fact }), identifiers: catalog.identifiers });
}
