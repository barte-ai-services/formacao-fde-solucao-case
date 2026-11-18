import type {
  InvoiceView,
  IssuedReturnNote,
  RequestStatus,
  RequestTextRejection,
  RequestType,
  ReturnNoteDraft,
  SupplierRequest,
  SupplierRequestText,
} from '../domain/index.js';
import type { ReturnNoteQueue } from '../returns/return-notes.js';

// #11: as portas do pedido ao fornecedor (#2). Os casos de uso dependem destas interfaces; o banco, a
// #11: caixa de saída mock e o relógio de verdade são das camadas de baixo (OLTP e API), não desta.

/** #11: o relógio do caso de uso; o domínio não lê a hora (ADR-005). */
export type Clock = { now(): Date };

/** #13: quem fez e quando, como a linha do pedido guarda (ADR-005); a raiz não os conhece. Nulos enquanto o ato não houve. */
export type RequestAudit = {
  readonly sentBy: string | null;
  readonly sentAt: string | null;
  readonly discardedBy: string | null;
  readonly discardedAt: string | null;
};

/** #11: o pedido como a persistência o guarda: a raiz, a devolução da fila e o e-mail do fornecedor. */
export type RequestRecord = {
  readonly request: SupplierRequest;
  /** #11: a devolução da fila (#140) que deu origem ao pedido; a raiz não a conhece. */
  readonly queueId: number;
  /** #11/AC-10 (#2): o e-mail de teste do fornecedor, onde o pedido é entregue. */
  readonly to: string;
  /** #13: o carimbo de quem enviou e descartou, para a API mostrar; o adaptador do Supabase o preenche, os dublês podem omitir. */
  readonly audit?: RequestAudit;
};

/** #11/AC-2: o que o Claude escreveu foi aceito (rascunho) ou recusado (nasce descartado com o motivo). */
export type DraftOutcome =
  | { readonly kind: 'draft'; readonly text: SupplierRequestText }
  | { readonly kind: 'rejected'; readonly rejection: RequestTextRejection };

/** #11: o que se grava de novo; quem grava dá o id e monta a raiz com ele (SupplierRequest.draft ou rejected). */
export type NewRequest = {
  readonly invoiceAccessKey: string;
  readonly queueId: number;
  readonly note: ReturnNoteDraft;
  readonly to: string;
  /** #11: o dia do rascunho, AAAA-MM-DD; o prazo conta daqui. */
  readonly draftedOn: string;
  /** #11: o modelo que escreveu o texto, para o registro. */
  readonly model: string;
  /** #12: quem fez o rascunho, para o histórico do pedido; a tarefa do Cron age como o agente. */
  readonly by: string;
  readonly outcome: DraftOutcome;
};

/** #11: `conflict` é o índice único parcial (um pedido aberto por nota de origem e tipo) que recusou a gravação. */
export type CreateResult = { readonly kind: 'ok'; readonly record: RequestRecord } | { readonly kind: 'conflict' };

/** #12/AC-4: o anexo que o envio registra no pedido; o conteúdo não é copiado, sai da nota emitida (append-only). */
export type SentAttachment = { readonly filename: string; readonly contentType: string; readonly issuedReturnNoteId: number };

/** #11/AC-4: o carimbo do envio (ADR-005): o canal, o identificador que ele deu e os anexos; quem e quando vêm do `RequestChange`. */
export type SendStamp = {
  readonly channel: 'mock' | 'resend';
  readonly providerMessageId: string;
  readonly attachments: readonly SentAttachment[];
};

/** #12: o ato que a gravação registra no histórico do pedido. */
export type RequestAction = 'edited' | 'issued' | 'sent' | 'send_failed' | 'discarded';

/** #12/AC-4: quem fez e quando em toda gravação (o histórico pede quem); o estado em si vem da raiz. */
export type RequestChange = {
  readonly by: string;
  readonly at: Date;
  readonly action: RequestAction;
  readonly sent?: SendStamp;
  /** #12/AC-4: a chave da trava do envio que grava; só o envio que a tomou a leva. Edição e descarte não levam e são recusados enquanto ela vive. */
  readonly claim?: string;
};

/** #12: `stale` é a versão lida que já não é a da linha, ou a trava de um envio em curso: 0 linhas no PATCH. */
export type SaveResult = 'ok' | 'stale';

/** #12: `claimed` leva a chave da trava (o provedor a usa para deduplicar); `conflict` é outro envio em curso ou versão velha. */
export type ClaimResult = { readonly kind: 'claimed'; readonly claim: string } | { readonly kind: 'conflict' };

export interface SupplierRequestStore {
  /** #11/AC-6: o pedido aberto (draft, sent ou send_failed) da nota de origem e do tipo, se houver. */
  findOpen(invoiceAccessKey: string, requestType: RequestType): Promise<RequestRecord | null>;
  get(id: number): Promise<RequestRecord | null>;
  /** #13: o pedido mais recente da nota de origem e do tipo, aberto ou não (a API mostra o descartado quando não há aberto). */
  findLatest(invoiceAccessKey: string, requestType: RequestType): Promise<RequestRecord | null>;
  /** #13: os pedidos em um estado, do mais novo ao mais antigo, até `limit` (a lista da tela). */
  listByStatus(status: RequestStatus, limit: number): Promise<readonly RequestRecord[]>;
  create(request: NewRequest): Promise<CreateResult>;
  /** #12/AC-4: grava o estado atual da raiz, com quem e quando; `stale` quando a linha mudou desde a leitura. */
  save(request: SupplierRequest, change: RequestChange): Promise<SaveResult>;
  /** #12/AC-4: toma a trava do envio antes de qualquer efeito; só um envio por vez segue. */
  claimSend(id: number, by: string, at: Date): Promise<ClaimResult>;
  /** #12/AC-4: solta a trava de um envio que parou antes de enviar (fila já tratada, por exemplo); só solta a que tem esta chave. */
  releaseSend(id: number, claim: string, by: string, at: Date): Promise<void>;
  /** #12/AC-6: das notas de origem perguntadas, as que têm pedido aberto do tipo, numa só leitura limitada a elas (sem chave, nenhuma leitura). */
  listOpenKeys(requestType: RequestType, invoiceAccessKeys: readonly string[]): Promise<ReadonlySet<string>>;
}

/** #11/AC-5: a emissão mock, idempotente por devolução da fila: a segunda chamada devolve a nota já emitida. */
export interface IssuedNoteStore {
  issue(queueId: number, draft: ReturnNoteDraft, issuedOn: string): Promise<IssuedReturnNote>;
}

/** #11/AC-10: a nota de origem e o e-mail de teste do fornecedor dela. */
export type SourceInvoice = { readonly invoice: InvoiceView; readonly supplierEmail: string };

export interface SourceInvoices {
  find(invoiceAccessKey: string): Promise<SourceInvoice | null>;
}

/** #11/AC-4: o anexo do e-mail; a nota emitida em JSON no formato do kit. */
export type MailAttachment = { readonly filename: string; readonly contentType: string; readonly content: string };

/** #11/AC-4: o e-mail pronto, com os números já no lugar dos marcadores. */
export type MailMessage = {
  readonly invoiceAccessKey: string;
  readonly supplierId: string;
  readonly requestType: RequestType;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly asks: readonly string[];
  readonly attachments: readonly MailAttachment[];
  readonly dueOn: string;
  /** #12: a chave da trava do envio; o provedor a usa para deduplicar, e o mock a põe no identificador. */
  readonly idempotencyKey: string;
};

/** #11/AC-5: `reason` é curto e próprio da porta (nunca o texto do provedor): vai para o pedido e para a pessoa. */
export type MailResult =
  | { readonly ok: true; readonly channel: 'mock' | 'resend'; readonly providerMessageId: string }
  | { readonly ok: false; readonly reason: string };

export interface SupplierMailer {
  send(message: MailMessage): Promise<MailResult>;
}

/** #11: tudo de que os casos de uso e a tarefa dependem. */
export type SupplierDeps = {
  readonly queue: ReturnNoteQueue;
  readonly requests: SupplierRequestStore;
  readonly notes: IssuedNoteStore;
  readonly source: SourceInvoices;
  readonly mailer: SupplierMailer;
  readonly clock: Clock;
};
