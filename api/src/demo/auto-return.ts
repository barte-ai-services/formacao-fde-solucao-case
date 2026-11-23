// #353 A devolução automática da demonstração: o pedido de devolução de valor pequeno é emitido e enviado sozinho.
// #353 O fluxo é o do clique "Emitir e enviar" (#156), sem o clique: a regra monta a nota (buildReturnNote), o texto passa pela mesma
// #353 conferência do texto do Claude (validateRequestText) e o banco emite a nota, marca o pedido como enviado e move a fila numa
// #353 transação só (rpc demo_auto_return_send). Portas e relógio injetados; nenhuma leitura da hora nem do banco aqui.
import { addBusinessDays, buildReturnNote, buildSupplierRequestFacts, DEFAULT_DUE_BUSINESS_DAYS, DomainError, Money, validateRequestText } from '../domain/index.js';
import type { InvoiceView, ReturnNoteDraft, ReturnQueueLine, SupplierRequestText } from '../domain/index.js';
import { factKey } from '../domain/dossier.js';
import { todayIso } from '../supplier/draft.js';
import type { Clock, DemoRoundStep } from './demo-step.js';

/** #353 O nome do passo na lista da rodada. */
export const AUTO_RETURN_STEP_NAME = 'devolucao-automatica';
/**
 * #353 Custo do passo medido em requisições (fetches): a leitura das devoluções pendentes que cabem no limite, com a nota de cada uma, é uma
 * rpc só (demo_auto_return_pending) e o envio do lote outra (demo_auto_return_send), da migração 20261123160000; o teste de medida prova o 2.
 */
export const AUTO_RETURN_COST = 2;
const DEFAULT_BATCH_LIMIT = 50;

/** #353 O rascunho que já espera a nota de origem (o do Claude): sai o texto dele, não um segundo pedido. */
export type OpenRequest = {
  readonly id: number;
  readonly version: number;
  /** #353 O dia do rascunho, AAAA-MM-DD: o prazo do pedido conta daqui. */
  readonly draftedOn: string;
  readonly text: SupplierRequestText;
};

/** #353 Uma devolução pendente da fila de uma nota da demonstração, com o que a regra precisa para montar a nota. */
export type PendingReturn = {
  readonly queueId: number;
  readonly invoice: InvoiceView;
  readonly lines: readonly ReturnQueueLine[];
  readonly supplierEmail: string;
  readonly request: OpenRequest | null;
};

/** #353 AC-3 O que a leitura traz: o limite do banco (centavos; zero desliga) e as devoluções candidatas. */
export type AutoReturnQueue = { readonly limitCents: number; readonly entries: readonly PendingReturn[] };

/** #353 O que o banco recebe por devolução: a nota montada, o texto, o destinatário e, se havia rascunho, qual e em que versão. */
export type AutoReturnSend = {
  readonly queueId: number;
  readonly invoiceAccessKey: string;
  readonly supplierId: string;
  readonly recipient: string;
  readonly note: ReturnNoteDraft;
  readonly text: SupplierRequestText;
  /** #353 O dia da emissão da nota (hoje, no fuso do caso). */
  readonly issuedOn: string;
  readonly draftedOn: string;
  readonly dueOn: string;
  readonly requestId: number | null;
  readonly requestVersion: number | null;
};

export type AutoReturnSource = { listPending(): Promise<AutoReturnQueue> };
export type AutoReturnSink = { sendBatch(batch: readonly AutoReturnSend[]): Promise<number> };

export type AutoReturnPlanOptions = { readonly clock: Clock; readonly batchLimit?: number };
export type AutoReturnStepOptions = AutoReturnPlanOptions & { readonly source: AutoReturnSource; readonly sink: AutoReturnSink };

/** #353 O texto do pedido automático: todo número é {{chave}} do catálogo do pedido, como a regra do texto do Claude exige. */
function defaultText(note: ReturnNoteDraft): SupplierRequestText {
  const items = note.items.map(
    (i) => `{{${factKey.returnItem(i.supplierCode, 'quantidade')}}} de ${i.supplierCode}, no valor de {{${factKey.returnItem(i.supplierCode, 'valor')}}}`,
  );
  return {
    subject: 'Devolução da nota {{nota.numero}}',
    body: `Segue a nota de devolução da nota {{nota.numero}}: ${items.join('; ')}. Total {{devolucao.total}}, retorno até {{prazo}}.`,
    asks: ['Confirmar o recebimento da nota de devolução', 'Creditar {{devolucao.total}} até {{prazo}}'],
  };
}

function planOne(entry: PendingReturn, limitCents: number, issuedOn: string): AutoReturnSend | null {
  let note: ReturnNoteDraft;
  try {
    note = buildReturnNote({ invoiceAccessKey: entry.invoice.accessKey, lines: [...entry.lines] }, entry.invoice);
  } catch (error) {
    // #353 A devolução que a regra não monta fica na fila para a pessoa, como no clique.
    if (error instanceof DomainError) return null;
    throw error;
  }
  // #353 AC-1 AC-2 "Até" o limite: o valor da devolução em centavos, a mesma soma da fila, contra o limite do banco.
  if (Money.fromReais(note.total).cents > limitCents) return null;
  const draftedOn = entry.request?.draftedOn ?? issuedOn;
  const dueOn = addBusinessDays(draftedOn, DEFAULT_DUE_BUSINESS_DAYS);
  const checked = validateRequestText(entry.request?.text ?? defaultText(note), buildSupplierRequestFacts(note, entry.invoice, dueOn));
  if (!checked.ok) return null;
  return {
    queueId: entry.queueId,
    invoiceAccessKey: entry.invoice.accessKey,
    supplierId: entry.invoice.supplierId,
    recipient: entry.supplierEmail,
    note,
    text: checked.text,
    issuedOn,
    draftedOn,
    dueOn,
    requestId: entry.request?.id ?? null,
    requestVersion: entry.request?.version ?? null,
  };
}

/** #353 Decide, pura, quais devoluções saem nesta rodada: as que cabem no limite, da mais antiga à mais nova, até o teto do lote. */
export function planAutoReturns(queue: AutoReturnQueue, options: AutoReturnPlanOptions): AutoReturnSend[] {
  if (queue.limitCents <= 0) return []; // #353 AC-3 zero desliga
  const issuedOn = todayIso(options.clock());
  const sends = queue.entries.flatMap((entry) => planOne(entry, queue.limitCents, issuedOn) ?? []);
  return sends.slice(0, options.batchLimit ?? DEFAULT_BATCH_LIMIT);
}

/** #353 Passo de rodada: uma leitura e, havendo devolução que cabe no limite, uma gravação em lote. */
export function autoReturnStep(options: AutoReturnStepOptions): DemoRoundStep {
  return {
    name: AUTO_RETURN_STEP_NAME,
    maxSubrequests: AUTO_RETURN_COST,
    run: async () => {
      const batch = planAutoReturns(await options.source.listPending(), options);
      if (batch.length === 0) return;
      await options.sink.sendBatch(batch);
    },
  };
}
