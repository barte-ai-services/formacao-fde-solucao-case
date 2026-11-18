import type { CheckContext } from './context.js';
import type { Divergence } from './divergence.js';
import type { InvoiceView } from './invoice.js';
import { Money } from './money.js';
import type { Quantity } from './quantity.js';

// #68: o dossiê da proposta encaminhada a uma pessoa. O Claude explica; quem decide é a regra ou
// uma pessoa. Todo número do texto vem do catálogo de fatos do banco, nunca do Claude (#38/AC-2).
//
// Contrato das chaves do catálogo. O job do Claude (#66) monta o prompt com estas chaves sem importar
// a api, então este esquema é o que ele copia; mudar uma chave aqui é mudar o contrato. `<código>` é
// o código do fornecedor do item; `<ordem>`, `<sku>` e `<recebimento>` são os ids como estão no banco.
//
//   nota.numero | nota.serie | nota.total | nota.itens.quantidade (#313)
//   nota.item[<código>].quantidade | .preco_unitario | .total
//   ordem[<ordem>].total | ordem[<ordem>].status
//   ordem[<ordem>].item[<código>].quantidade | .preco_unitario | .saldo
//   cadastro.produto[<sku>].fator_caixa | cadastro.produto[<sku>].preco_referencia
//   cadastro.fornecedor.bloqueado
//   recebimento[<recebimento>].item[<código>].quantidade
//   historico.notas_lancadas.quantidade | historico.notas_lancadas.valor
//   historico.pagamentos.quantidade | historico.pagamentos.valor
//   historico.notas_capturadas.quantidade
//   devolucao.item[<código>].quantidade | .valor | devolucao.total | prazo   (pedido ao fornecedor, #156)
//
// No texto, um fato aparece só como o marcador {{chave}}. Fora dos marcadores, só identificadores
// (`FactCatalog.identifiers`) podem ter algarismos.

export type FactSource = 'invoice' | 'purchase_order' | 'registry' | 'receipt' | 'history' | 'return_note'; // #68, #156

export type Fact = {
  readonly label: string;
  /** #68: o valor formatado como está no banco: dinheiro por `Money.toString()`, quantidade com a unidade. */
  readonly value: string;
  readonly source: FactSource;
};

export type FactCatalog = {
  /** #68: chave estável e legível → fato, como `nota.item[A1].quantidade`. */
  readonly facts: Readonly<Record<string, Fact>>;
  /** #68: o que pode aparecer no texto sem marcador: chaves, códigos, datas. Nunca uma quantidade ou um valor. */
  readonly identifiers: readonly string[];
  /**
   * #313: o número da nota e o das notas que as evidências apontam. Fica fora de `identifiers`: só passa
   * no texto logo depois de "nota", "NF" ou "NF-e", senão "13773 caixas" passaria por quantidade.
   */
  readonly invoiceNumbers?: readonly string[];
};

export type DossierEvidence = {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly source: FactSource;
};

export type DossierDivergence = {
  readonly classification: string;
  /** #128: o nome do glossário, posto pela API; ausente se o código não é catalogado. */
  readonly exceptionName?: string;
  readonly whatDiverges: string;
  readonly evidence: readonly DossierEvidence[];
};

/** #68: o dossiê pronto. Não tem ação, nível nem valor em risco: esses vêm da regra (#38/AC-3). */
export type Dossier = {
  readonly status: 'ready'; // #68
  readonly summary: string;
  readonly divergences: readonly DossierDivergence[];
  readonly supplierHistory: string;
  readonly generatedAt: string;
  readonly model: string;
};

export type DossierUnavailableReason =
  | 'claude_failed' // #68
  | 'number_mismatch' // #68
  | 'invalid_shape' // #68
  | 'timeout'; // #130 o Claude passou do prazo

/** #296: qual das quatro verificações do texto do Claude derrubou o dossiê. */
export type DossierMismatchCheck =
  | 'loose_number'
  | 'spelled_number'
  | 'item_count_mismatch' // #313
  | 'unknown_key' | 'unknown_classification';

/** #296: o detalhe de um `number_mismatch`, para o log. Nunca vai à resposta da API nem à tela. */
export type DossierMismatch = {
  readonly check: DossierMismatchCheck;
  /** #296: onde, na saída do Claude: `summary`, `supplier_history`, `divergences[i].what_diverges`, `.evidence` ou `.classification`. */
  readonly field: string;
  /** #296: o token ou a chave que derrubou, cortado em `MAX_CITED_LENGTH` caracteres; nunca o texto inteiro. */
  readonly cited: string;
  /**
   * #296: o que o banco tem para comparar: as classificações reais da nota, separadas por vírgula, em
   * `unknown_classification`. `null` quando o banco não tem valor correspondente: um número solto
   * ou por extenso não está ligado a chave nenhuma, e uma chave desconhecida não existe no catálogo.
   * #313: em `item_count_mismatch`, a quantidade de itens da nota (`nota.itens.quantidade`), ou `null` sem o fato.
   */
  readonly bank: string | null;
};

export type DossierUnavailable = {
  readonly status: 'unavailable'; // #68
  readonly reason: DossierUnavailableReason;
  readonly generatedAt: string;
  /** #296: presente só em `number_mismatch` vindo de `verifyAndRender`. */
  readonly mismatch?: DossierMismatch;
};

export type DossierResult = Dossier | DossierUnavailable;

export type DossierMeta = { readonly generatedAt: string; readonly model: string };

/**
 * #68: o schema da saída estruturada do Claude. Nos textos, todo número aparece só como `{{chave}}`
 * do catálogo; `evidence` são chaves do catálogo. Sem campo de ação, nível nem valor em risco.
 */
export const DOSSIER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'divergences', 'supplier_history'],
  properties: {
    summary: { type: 'string' },
    divergences: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['classification', 'what_diverges', 'evidence'],
        properties: {
          classification: { type: 'string' },
          what_diverges: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    supplier_history: { type: 'string' },
  },
} as const;

type ItemField = 'quantidade' | 'preco_unitario' | 'total';
type OrderItemField = 'quantidade' | 'preco_unitario' | 'saldo';
type ReturnItemField = 'quantidade' | 'valor'; // #156

/** #68: como cada chave do catálogo se escreve. É o contrato descrito no topo deste arquivo. */
export const factKey = {
  invoiceNumber: (): string => 'nota.numero',
  invoiceSeries: (): string => 'nota.serie',
  invoiceTotal: (): string => 'nota.total',
  invoiceItemCount: (): string => 'nota.itens.quantidade', // #313
  invoiceItem: (supplierCode: string, field: ItemField): string => `nota.item[${supplierCode}].${field}`,
  orderTotal: (orderId: string): string => `ordem[${orderId}].total`,
  orderStatus: (orderId: string): string => `ordem[${orderId}].status`,
  orderItem: (orderId: string, supplierCode: string, field: OrderItemField): string =>
    `ordem[${orderId}].item[${supplierCode}].${field}`,
  productBoxFactor: (sku: string): string => `cadastro.produto[${sku}].fator_caixa`,
  productReferencePrice: (sku: string): string => `cadastro.produto[${sku}].preco_referencia`,
  supplierBlocked: (): string => 'cadastro.fornecedor.bloqueado',
  receiptItem: (receiptId: string, supplierCode: string): string =>
    `recebimento[${receiptId}].item[${supplierCode}].quantidade`,
  postedCount: (): string => 'historico.notas_lancadas.quantidade',
  postedValue: (): string => 'historico.notas_lancadas.valor',
  paymentCount: (): string => 'historico.pagamentos.quantidade',
  paymentValue: (): string => 'historico.pagamentos.valor',
  capturedCount: (): string => 'historico.notas_capturadas.quantidade',
  // #156: o catálogo do pedido ao fornecedor (nota de devolução e prazo).
  returnItem: (supplierCode: string, field: ReturnItemField): string => `devolucao.item[${supplierCode}].${field}`,
  returnTotal: (): string => 'devolucao.total',
  dueDate: (): string => 'prazo',
  // #157: o novo prazo da cobrança (3 dias úteis depois da varredura), que o pedido original não tem.
  followUpDueDate: (): string => 'cobranca.prazo',
} as const;

/** #68: as chaves do catálogo, em ordem estável. */
export function catalogKeys(catalog: FactCatalog): string[] {
  return Object.keys(catalog.facts).sort();
}

const qty = (q: Quantity): string => `${q.amount} ${q.unit}`;
const sum = (ms: readonly Money[]): Money => ms.reduce((acc, m) => acc.add(m), Money.zero());

/** #68: número curto puro (como o número da nota) só entra por marcador: senão passaria por quantidade. */
const MIN_NUMERIC_IDENTIFIER = 8;

const ACCESS_KEY_FORMAT = /^\d{44}$/;

/** #313: o número da nota (nNF, 9 dígitos nas posições 26 a 34 da chave de 44 dígitos), sem zeros à esquerda. */
function invoiceNumberOfAccessKey(accessKey: string): string | null {
  if (!ACCESS_KEY_FORMAT.test(accessKey)) return null;
  return accessKey.slice(25, 34).replace(/^0+/, '') || null;
}

/** #313: o número da própria nota e o de cada nota apontada por uma chave de acesso de 44 dígitos. */
export function collectInvoiceNumbers(ownNumber: string, accessKeys: readonly string[]): readonly string[] {
  const numbers = new Set<string>(ownNumber ? [ownNumber] : []);
  for (const key of accessKeys) {
    const number = invoiceNumberOfAccessKey(key);
    if (number) numbers.add(number);
  }
  return [...numbers];
}

/** #68: monta o catálogo plano de fatos do banco para a nota e o fornecedor dela. */
export function buildFactCatalog(invoice: InvoiceView, ctx: CheckContext): FactCatalog {
  const facts: Record<string, Fact> = {};
  const ids = new Set<string>();
  const put = (key: string, label: string, value: string, source: FactSource) => {
    facts[key] = Object.freeze({ label, value, source });
  };
  const id = (...values: readonly (string | null | undefined)[]) => {
    for (const v of values) if (v) ids.add(v);
  };

  put(factKey.invoiceNumber(), 'Número da nota', invoice.number, 'invoice');
  put(factKey.invoiceSeries(), 'Série da nota', invoice.series, 'invoice');
  put(factKey.invoiceTotal(), 'Valor total da nota', invoice.total.toString(), 'invoice');
  put(factKey.invoiceItemCount(), 'Quantidade de itens da nota', String(invoice.items.length), 'invoice'); // #313
  id(invoice.accessKey, invoice.supplierId, invoice.store, invoice.issuedOn, invoice.purchaseOrderRef);
  for (const item of invoice.items) {
    put(factKey.invoiceItem(item.supplierCode, 'quantidade'), `Quantidade faturada de ${item.description}`, qty(item.quantity), 'invoice');
    put(factKey.invoiceItem(item.supplierCode, 'preco_unitario'), `Preço unitário faturado de ${item.description}`, item.unitPrice.toString(), 'invoice');
    put(factKey.invoiceItem(item.supplierCode, 'total'), `Total faturado de ${item.description}`, item.total.toString(), 'invoice');
    id(item.supplierCode, item.sku);
  }
  for (const d of invoice.divergences) {
    id(d.classification, ...d.skus, ...d.evidence.map((e) => e.reference));
  }

  const order = ctx.purchaseOrders.find((o) => o.id === invoice.purchaseOrderRef);
  if (order) {
    put(factKey.orderTotal(order.id), `Valor total da ordem ${order.id}`, order.total.toString(), 'purchase_order');
    put(factKey.orderStatus(order.id), `Situação da ordem ${order.id}`, order.status, 'purchase_order');
    id(order.id, order.issuedOn, order.store);
    for (const item of order.items) {
      put(factKey.orderItem(order.id, item.supplierCode, 'quantidade'), `Quantidade pedida de ${item.description}`, qty(item.quantity), 'purchase_order');
      put(factKey.orderItem(order.id, item.supplierCode, 'preco_unitario'), `Preço unitário pedido de ${item.description}`, item.unitPrice.toString(), 'purchase_order');
      put(factKey.orderItem(order.id, item.supplierCode, 'saldo'), `Saldo da ordem para ${item.description}`, qty(item.balance), 'purchase_order');
      id(item.supplierCode, item.sku);
    }
  }

  const skus = new Set<string>([
    ...invoice.items.flatMap((i) => (i.sku ? [i.sku] : [])),
    ...(order?.items.flatMap((i) => (i.sku ? [i.sku] : [])) ?? []),
  ]);
  for (const p of ctx.products.filter((p) => skus.has(p.sku))) {
    put(factKey.productBoxFactor(p.sku), `Unidades por caixa de ${p.description}`, `${p.boxFactor} ${p.baseUnit} por CX`, 'registry');
    put(factKey.productReferencePrice(p.sku), `Preço de referência por ${p.baseUnit} de ${p.description}`, p.referenceUnitPrice.toString(), 'registry');
    id(p.sku, p.supplierCode);
  }

  const supplier = ctx.suppliers.find((s) => s.id === invoice.supplierId);
  if (supplier) {
    put(factKey.supplierBlocked(), 'Fornecedor com pagamento bloqueado', supplier.paymentBlocked ? 'sim' : 'não', 'registry');
    id(supplier.id, supplier.cnpj);
  }

  const receipts = ctx.receipts.filter(
    (r) => r.invoiceAccessKey === invoice.accessKey || (r.purchaseOrderId !== null && r.purchaseOrderId === invoice.purchaseOrderRef),
  );
  for (const r of receipts) {
    id(r.id, r.receivedOn);
    for (const item of r.items) {
      put(factKey.receiptItem(r.id, item.supplierCode), `Quantidade contada de ${item.description}`, qty(item.quantity), 'receipt');
    }
  }

  const posted = ctx.postedInvoices.filter((p) => p.supplierId === invoice.supplierId && p.accessKey !== invoice.accessKey);
  const payments = ctx.payments.filter((p) => p.supplierId === invoice.supplierId);
  const captured = ctx.capturedInvoices.filter((c) => c.supplierId === invoice.supplierId && !invoice.equals(c));
  put(factKey.postedCount(), 'Notas do fornecedor já lançadas', String(posted.length), 'history');
  put(factKey.postedValue(), 'Valor das notas do fornecedor já lançadas', sum(posted.map((p) => p.total)).toString(), 'history');
  put(factKey.paymentCount(), 'Pagamentos ao fornecedor', String(payments.length), 'history');
  put(factKey.paymentValue(), 'Valor pago ao fornecedor', sum(payments.map((p) => p.amount)).toString(), 'history');
  put(factKey.capturedCount(), 'Outras notas do fornecedor capturadas', String(captured.length), 'history');

  const identifiers = [...ids].filter((v) => !(/^\d+$/.test(v) && v.length < MIN_NUMERIC_IDENTIFIER));
  // #313: o número da nota fica fora de `identifiers`; só vale depois de "nota", em `textChecks`.
  const references = invoice.divergences.flatMap((d) => d.evidence.map((e) => e.reference));
  const invoiceNumbers = collectInvoiceNumbers(invoice.number, [invoice.accessKey, ...references]);
  return Object.freeze({
    facts: Object.freeze(facts),
    identifiers: Object.freeze(identifiers),
    invoiceNumbers: Object.freeze(invoiceNumbers),
  });
}

type RawDivergence = { classification: string; what_diverges: string; evidence: string[] };
type RawDossier = { summary: string; divergences: RawDivergence[]; supplier_history: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** #68: lê só os campos do schema. Campo a mais (como `acao` ou `nivel`) é descartado, nunca copiado. */
function parseRaw(raw: unknown): RawDossier | null {
  if (!isRecord(raw)) return null;
  const { summary, divergences, supplier_history } = raw;
  if (typeof summary !== 'string' || typeof supplier_history !== 'string' || !Array.isArray(divergences)) return null;
  const parsed: RawDivergence[] = [];
  for (const d of divergences) {
    if (!isRecord(d)) return null;
    const { classification, what_diverges, evidence } = d;
    if (typeof classification !== 'string' || typeof what_diverges !== 'string' || !isStringArray(evidence)) return null;
    // #68, regra 6: toda divergência cita ao menos uma evidência.
    if (evidence.length === 0) return null;
    parsed.push({ classification, what_diverges, evidence });
  }
  return { summary, divergences: parsed, supplier_history };
}

const MARKER = /\{\{([^{}]+)\}\}/g;
const EDGE_PUNCTUATION = /^[("'“‘[]+|[)"'”’\].,;:!?]+$/g;

/**
 * #68: numerais por extenso que o texto do Claude não pode ter fora de um marcador, comparados em
 * minúsculas e sem acento. `um`/`uma` ficam de fora porque também são artigo; um número escrito
 * assim ainda passa pela conferência (limitação conhecida, #68).
 */
const SPELLED_NUMBERS: ReadonlySet<string> = new Set([
  'dois', 'duas', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez',
  'onze', 'doze', 'treze', 'catorze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove',
  'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa',
  'cem', 'cento', 'duzentos', 'duzentas', 'trezentos', 'trezentas', 'quatrocentos', 'quatrocentas',
  'quinhentos', 'quinhentas', 'seiscentos', 'seiscentas', 'setecentos', 'setecentas',
  'oitocentos', 'oitocentas', 'novecentos', 'novecentas',
  'mil', 'milhao', 'milhoes', 'bilhao', 'bilhoes',
  'dezena', 'dezenas', 'duzia', 'duzias', 'centena', 'centenas', 'metade', 'dobro', 'triplo',
]);

/** #68: o token em minúsculas e sem acento, para comparar com os numerais por extenso. */
const folded = (token: string): string => token.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** #296: o `cited` de um `DossierMismatch` tem no máximo este tamanho: o token ou a chave, nunca o texto. */
const MAX_CITED_LENGTH = 64;

type TextFailure = {
  readonly check: DossierMismatchCheck;
  readonly cited: string;
  /** #313: o valor do banco para comparar, em `item_count_mismatch`. */
  readonly bank?: string | null;
};

/** #313: os numerais por extenso de valor inteiro simples, que podem contar os itens da nota. `um`/`uma` ficam fora. */
const COUNT_WORDS: Readonly<Record<string, number>> = {
  dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezessete: 17,
  dezoito: 18, dezenove: 19, vinte: 20,
};

/** #313: as palavras que, logo depois de um numeral, o fazem contar os itens da nota. */
const ITEM_WORDS: ReadonlySet<string> = new Set(['item', 'itens', 'sku', 'skus']);

/** #313: o que vem antes e depois de um token no texto, com a posição de cada marcador ocupada. */
type Neighbours = { readonly previous: string; readonly next: string };

/** #313: o lugar de um marcador no texto: ocupa uma posição, para o marcador não ligar a palavra ao número. */
const MARKER_SLOT = '\uFFFC';

/** #313: as palavras que dão contexto a um número de nota, em minúsculas e sem acento. */
const INVOICE_WORDS: ReadonlySet<string> = new Set(['nota', 'nf', 'nf-e', 'nfe']);

const SLASH_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** #313: a data `dd/mm/aaaa` está na lista como `aaaa-mm-dd`. */
function isListedSlashDate(bare: string, allowed: ReadonlySet<string>): boolean {
  const parts = SLASH_DATE.exec(bare);
  return parts !== null && allowed.has(`${parts[3]}-${parts[2]}-${parts[1]}`);
}

/**
 * #313: um numeral por extenso. Seguido de item/itens/SKU/SKUs, passa se for a quantidade de itens da
 * nota no catálogo; senão cai como `item_count_mismatch`. Qualquer outro numeral cai como `spelled_number`.
 */
function spelledFailure(bare: string, next: string, catalog: FactCatalog): TextFailure | null {
  const word = folded(bare);
  if (!SPELLED_NUMBERS.has(word)) return null;
  const count = COUNT_WORDS[word];
  if (count === undefined || !ITEM_WORDS.has(folded(next.replace(EDGE_PUNCTUATION, '')))) {
    return { check: 'spelled_number', cited: bare };
  }
  const bank = catalog.facts[factKey.invoiceItemCount()]?.value ?? null;
  return bank === String(count) ? null : { check: 'item_count_mismatch', cited: bare, bank };
}

/**
 * #313: a primeira falha de um token separado por espaço. O token inteiro na lista (CNPJ com barra) ou
 * a data com barra da lista passam; senão cada pedaço entre barras passa pelas verificações de sempre
 * (#68), e um número de nota só passa logo depois de uma palavra de `INVOICE_WORDS`.
 */
function tokenFailure(
  token: string,
  near: Neighbours,
  catalog: FactCatalog,
  allowed: ReadonlySet<string>,
): TextFailure | null {
  const whole = token.replace(EDGE_PUNCTUATION, '');
  const listed = allowed.has(whole) || isListedSlashDate(whole, allowed);
  const previous = near.previous.replace(/^[("'“‘[]+/, '').replace(/:$/, '');
  const afterInvoiceWord = INVOICE_WORDS.has(folded(previous));
  const pieces = token.split('/');
  for (const [index, piece] of pieces.entries()) {
    const bare = piece.replace(EDGE_PUNCTUATION, '');
    const isInvoiceNumber = index === 0 && afterInvoiceWord && (catalog.invoiceNumbers ?? []).includes(bare);
    // #68: \p{N} pega também dígitos fora do ASCII (como `１５`), que o `\d` deixava passar.
    if (/\p{N}/u.test(bare) && !listed && !allowed.has(bare) && !isInvoiceNumber) return { check: 'loose_number', cited: bare };
    // #313: a contagem só conta com a palavra seguinte quando o token não tem barra.
    const spelled = spelledFailure(bare, pieces.length === 1 && !/[)"'”’\].,;:!?]$/.test(piece) ? near.next : '', catalog);
    if (spelled) return spelled;
  }
  return null;
}

/** #296: a primeira verificação que o texto não passa, ou `null` se confere: marcadores primeiro, depois os tokens. */
function firstTextFailure(text: string, catalog: FactCatalog, allowed: ReadonlySet<string>): TextFailure | null {
  for (const m of text.matchAll(MARKER)) {
    const key = m[1] ?? '';
    if (!Object.hasOwn(catalog.facts, key)) return { check: 'unknown_key', cited: key };
  }
  // #313: a quebra de linha desfaz o contexto, como o marcador; o `\s+` a trataria como um espaço.
  const tokens = text
    .replace(MARKER, ` ${MARKER_SLOT} `)
    .replace(/[\r\n\u2028\u2029]+/g, ` ${MARKER_SLOT} `)
    .split(/\s+/);
  for (const [i, token] of tokens.entries()) {
    const failure = tokenFailure(token, { previous: tokens[i - 1] ?? '', next: tokens[i + 1] ?? '' }, catalog, allowed);
    if (failure) return failure;
  }
  return null;
}

/** #68: o texto confere quando todo marcador está no catálogo e nenhum número sobra fora dos marcadores. */
export function textChecks(text: string, catalog: FactCatalog, allowed: ReadonlySet<string>): boolean {
  return firstTextFailure(text, catalog, allowed) === null;
}

const mismatchOf = (check: DossierMismatchCheck, field: string, cited: string, bank: string | null): DossierMismatch =>
  Object.freeze({ check, field, cited: cited.slice(0, MAX_CITED_LENGTH), bank });

export const renderText = (text: string, catalog: FactCatalog): string =>
  text.replace(MARKER, (_, key: string) => catalog.facts[key]?.value ?? '');

const unavailable = (
  reason: DossierUnavailableReason,
  generatedAt: string,
  mismatch?: DossierMismatch,
): DossierUnavailable =>
  Object.freeze(mismatch ? { status: 'unavailable', reason, generatedAt, mismatch } : { status: 'unavailable', reason, generatedAt });

/** #296: a primeira falha dos textos, na ordem summary, supplier_history, what_diverges de cada divergência. */
function firstTextMismatch(parsed: RawDossier, catalog: FactCatalog, allowed: ReadonlySet<string>): DossierMismatch | null {
  const texts: readonly (readonly [string, string])[] = [
    ['summary', parsed.summary],
    ['supplier_history', parsed.supplier_history],
    ...parsed.divergences.map((d, i): readonly [string, string] => [`divergences[${i}].what_diverges`, d.what_diverges]),
  ];
  for (const [field, text] of texts) {
    const failure = firstTextFailure(text, catalog, allowed);
    if (failure) return mismatchOf(failure.check, field, failure.cited, failure.bank ?? null);
  }
  return null;
}

/** #296: a primeira falha, por divergência, da classificação e depois das evidências. */
function firstDivergenceMismatch(
  parsed: RawDossier,
  catalog: FactCatalog,
  real: ReadonlySet<string>,
): DossierMismatch | null {
  for (const [i, d] of parsed.divergences.entries()) {
    if (!real.has(d.classification)) {
      return mismatchOf('unknown_classification', `divergences[${i}].classification`, d.classification, [...real].join(','));
    }
    const unknown = d.evidence.find((k) => !Object.hasOwn(catalog.facts, k));
    if (unknown !== undefined) return mismatchOf('unknown_key', `divergences[${i}].evidence`, unknown, null);
  }
  return null;
}

/**
 * #68: confere a resposta crua do Claude contra o catálogo e as divergências reais da nota, e
 * renderiza os marcadores com os valores do banco. Qualquer número que não confere → indisponível,
 * com a primeira falha em `mismatch` (#296).
 */
export function verifyAndRender(
  raw: unknown,
  catalog: FactCatalog,
  divergences: readonly Divergence[],
  meta: DossierMeta,
): DossierResult {
  const parsed = parseRaw(raw);
  if (!parsed) return unavailable('invalid_shape', meta.generatedAt);

  const allowed = new Set(catalog.identifiers);
  const real = new Set<string>(divergences.map((d) => d.classification));
  const mismatch = firstTextMismatch(parsed, catalog, allowed) ?? firstDivergenceMismatch(parsed, catalog, real);
  if (mismatch) return unavailable('number_mismatch', meta.generatedAt, mismatch);

  const evidence = (key: string): DossierEvidence => {
    const fact = catalog.facts[key]!; // #68: conferido acima
    return Object.freeze({ key, label: fact.label, value: fact.value, source: fact.source });
  };
  return Object.freeze({
    status: 'ready',
    summary: renderText(parsed.summary, catalog),
    divergences: Object.freeze(
      parsed.divergences.map((d) =>
        Object.freeze({
          classification: d.classification,
          whatDiverges: renderText(d.what_diverges, catalog),
          evidence: Object.freeze(d.evidence.map(evidence)),
        }),
      ),
    ),
    supplierHistory: renderText(parsed.supplier_history, catalog),
    generatedAt: meta.generatedAt,
    model: meta.model,
  });
}

/**
 * #68: por que a tela não tem dossiê. `pending`: o job ainda não gerou. `read_failed`: o Worker não
 * conseguiu ler o dossiê agora; a proposta segue sem ele (#38/AC-4).
 */
export type DossierNoticeReason = DossierUnavailableReason | 'pending' | 'read_failed';

const REASON_TEXT: Readonly<Record<DossierNoticeReason, string>> = {
  claude_failed: 'o Claude não respondeu',
  number_mismatch: 'um número do texto do Claude não conferiu com o banco',
  invalid_shape: 'a resposta do Claude veio fora do formato',
  timeout: 'o Claude demorou demais para responder',
  pending: 'o dossiê ainda não foi gerado',
  read_failed: 'não foi possível ler o dossiê agora',
};

/** #68: o aviso da tela para um motivo de não haver dossiê. */
export function dossierNoticeFor(reason: DossierNoticeReason): string {
  return `Não há dossiê para esta proposta: ${REASON_TEXT[reason]}. Decida pelas divergências e evidências da conferência.`;
}

/** #68: o dossiê como o fio leva à tela, quando não há um pronto. */
export type DossierFieldUnavailable = {
  readonly status: 'unavailable'; // #68
  /** #68: `pending`: o job do Claude ainda não gerou o dossiê desta nota. */
  readonly reason: DossierNoticeReason;
  /** #68: o texto, em português, que a tela mostra no lugar do dossiê (#38/AC-4). */
  readonly notice: string;
  /** #68: `null` quando pendente: nada foi gerado ainda. */
  readonly generatedAt: string | null;
};

/** #68: o campo `dossier` da proposta em `GET /api/propostas/:chave`. */
export type DossierField = Dossier | DossierFieldUnavailable;

/**
 * #38/AC-4: o aviso da tela quando não há dossiê. `null` é o dossiê ainda não gerado. Pronto não
 * tem aviso.
 */
export function dossierNotice(result: DossierResult | null): string | null {
  if (result?.status === 'ready') return null;
  return dossierNoticeFor(result?.reason ?? 'pending');
}
