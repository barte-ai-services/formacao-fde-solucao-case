import type {
  DocumentConfirmation,
  RequestFilter,
  RequestStatus,
  RequestType,
  ReturnNoteDraft,
  SupplierReading,
  SupplierRequestText,
} from '../domain/index.js';

// #157: as portas da leitura da resposta do fornecedor (#157). Os casos de uso dependem destas interfaces;
// #157: o banco, a caixa de entrada mock, a caixa de saída e o relógio de verdade são das camadas de baixo.
// #157: nenhuma porta aqui escreve na proposta, no título nem no valor em risco (#157): a gravação só alcança a leitura.

/** #157: o relógio do caso de uso; igual ao de #156 (ADR-005): o domínio não lê a hora. */
export type Clock = { now(): Date };

/** #157: a resposta do fornecedor na caixa de entrada mock (inbox_supplier_messages), ligada ao pedido. */
export type InboxMessage = {
  readonly id: number;
  readonly requestId: number;
  /** #157: o texto do fornecedor: dado, nunca instrução; só o prompt o lê, escapado em <dados>. */
  readonly text: string;
};

export interface SupplierInbox {
  /** #157: as mensagens com read_status `pending`. */
  listPending(): Promise<InboxMessage[]>;
  /** #157: a mensagem, se ainda estiver `pending`; lida, com erro ou inexistente, null. */
  get(id: number): Promise<InboxMessage | null>;
  /** #157: a leitura foi aceita e gravada: a mensagem fica lida. */
  markRead(id: number): Promise<void>;
  /** #157: a leitura foi recusada: a mensagem fica `error` com o motivo fechado, nunca com o texto do modelo ou do fornecedor. */
  markError(id: number, reason: string): Promise<void>;
}

/** #157: o carimbo do envio da cobrança (ADR-005); o mesmo formato do carimbo de #156. */
export type FollowUpStamp = {
  readonly by: string;
  readonly at: Date;
  readonly channel: 'mock' | 'resend';
  readonly providerMessageId: string;
};

/** #157: o estado da cobrança no pedido. */
export type FollowUpState = {
  /** #157: o rascunho no formato do pedido, com {{chave}}; null enquanto não há. */
  readonly draft: SupplierRequestText | null;
  /** #157: o novo prazo da cobrança (AAAA-MM-DD), gravado com o rascunho; é dele o fato `cobranca.prazo`. Nulo sem rascunho, ou no rascunho do Claude, de antes da #157. */
  readonly dueOn: string | null;
  /** #157: o motivo de o texto do Claude ter sido recusado; sem rascunho. Só leitura: desde a #157 a regra monta a cobrança e nada grava uma recusa, mas as já gravadas seguem aqui. */
  readonly rejection: string | null;
  /** #157: quem e quando enviou; null enquanto não saiu. */
  readonly sent: FollowUpStamp | null;
  /** #157: o motivo curto da última falha do envio, da própria porta; nunca o texto do provedor. */
  readonly failure: string | null;
};

/** #157: o pedido como a leitura o vê: o que a lista, o prazo e a cobrança precisam. */
export type ReplyRequest = {
  readonly id: number;
  readonly invoiceAccessKey: string;
  readonly invoiceNumber: string;
  readonly supplierName: string | null;
  readonly requestType: RequestType;
  /** #157: o e-mail de teste do fornecedor, onde a cobrança é entregue. */
  readonly to: string;
  /** #157: a nota montada pela regra; dela vêm o fornecedor, o total e o catálogo de fatos. */
  readonly note: ReturnNoteDraft;
  /** #157: o que pedimos, como o pedido guarda (forma com {{chave}}). */
  readonly asks: readonly string[];
  readonly subject: string;
  readonly dueOn: string;
  readonly status: RequestStatus;
  readonly reading: SupplierReading | null;
  /** #157: a confirmação do documento citado na leitura atual: o documento, quem e quando; null enquanto a pessoa não confirmou. */
  readonly documentConfirmation: DocumentConfirmation | null;
  readonly followUp: FollowUpState;
};

/** #157, #157: `superseded` é a leitura gravada no log que não é a atual: o pedido tem uma de mensagem mais nova. */
export type ReadingRecorded = 'recorded' | 'superseded';

/** #157: a ficha da reivindicação do envio: o que a prende a quem a ganhou (como a da #156). Nunca sai do armazém nem entra em log. */
export type FollowUpClaim = string;

/**
 * #157 (lost update): o resultado de reivindicar o envio. `won` traz a ficha; `taken`: já há envio reivindicado dentro do prazo, ou
 * carimbado, ou não há o que enviar; `stale`: o texto que o envio leu já não é o gravado (uma edição entrou no meio): refaz a leitura.
 */
export type ClaimAttempt =
  | { readonly kind: 'won'; readonly claim: FollowUpClaim }
  | { readonly kind: 'taken' }
  | { readonly kind: 'stale' };

/** #157: o resultado de editar o rascunho; só `recorded` gravou. */
export type EditWrite = 'recorded' | 'already_sent' | 'send_in_progress' | 'stale';

/** #157: o resultado de confirmar o documento; só `recorded` gravou. `stale`: a linha andou por outra gravação entre a leitura e o PATCH. */
export type ConfirmWrite = 'recorded' | 'already_confirmed' | 'stale';

/** #157: `lost` quer dizer que a reivindicação já não é de quem gravou (venceu e outro a retomou, ou foi solta): nada foi gravado. */
export type ClaimWrite = 'recorded' | 'lost';

/**
 * #157: a gravação do pedido. Só há escrita da leitura e da cobrança: não existe método para a
 * proposta, o título nem o valor em risco, então a tarefa não tem como tocá-los.
 */
export interface ReplyRequestStore {
  get(id: number): Promise<ReplyRequest | null>;
  /** #157: os pedidos `sent`; é de onde saem a varredura (que monta a cobrança, #157) e a lista. */
  listSent(): Promise<ReplyRequest[]>;
  /**
   * #157, #157: grava a leitura do pedido como um fato novo (append-only), numa requisição só, sem ler antes.
   * `messageId` é a mensagem de onde ela veio. A leitura atual do pedido é derivada pela ordem das mensagens:
   * a de maior id vence, e a leitura de qualquer mensagem vence a da varredura do prazo (origem nula), então a
   * resposta tardia vence o no_reply (#157). Uma leitura antiga que chega depois de uma nova (o runner #157 roda as
   * chaves novas antes das retentativas) é gravada e perde pela ordem. `superseded` quer dizer: gravada no log,
   * mas não é a leitura atual. A mesma mensagem lida duas vezes mantém a primeira leitura. `null` é a varredura
   * do prazo: grava um único no_reply por pedido e, se já havia um, devolve `superseded`.
   */
  recordReading(id: number, reading: SupplierReading, messageId: number | null): Promise<ReadingRecorded>;
  /**
   * #157: grava o rascunho montado pela regra, com o novo prazo, só se o pedido ainda não tem rascunho nem recusa (a cobrança não
   * se repete): com um dos dois já gravado, volta sem gravar. O histórico leva o nome da varredura como quem gravou (ADR-005).
   */
  saveFollowUpDraft(id: number, text: SupplierRequestText, dueOn: string): Promise<void>;
  /**
   * #157, AC-5: troca o texto do rascunho (o novo prazo fica) e grava `by` no histórico (ADR-005). Só vale para o rascunho sem
   * carimbo e sem envio reivindicado: `already_sent` e `send_in_progress` dizem por que não gravou, e `stale` é a versão que andou
   * no meio. Pedido ou rascunho que não existem lançam, como as outras gravações.
   */
  editFollowUpDraft(id: number, text: SupplierRequestText, by: string): Promise<EditWrite>;
  /**
   * #157, AC-4: grava a confirmação do documento (quem e quando, ADR-005) como uma entrada do histórico da linha do pedido, num `PATCH`
   * guardado pela versão lida: duas chamadas ao mesmo tempo gravam uma só, e a outra volta `already_confirmed`. Não toca a leitura, a cobrança,
   * a proposta, o título nem o valor em risco (#157). Pedido que não existe lança, como as outras gravações.
   */
  confirmDocument(id: number, confirmation: DocumentConfirmation): Promise<ConfirmWrite>;
  /**
   * #157: reivindica o envio da cobrança antes do e-mail sair. Devolve a ficha da reivindicação (#157, o `send_claim` da #156)
   * para quem ganhou (`won`), e `taken` se já há envio reivindicado dentro do prazo ou carimbado. #157: `draft` é o texto que o envio leu
   * e vai mandar; a reivindicação só vale sobre ele, na versão lida: se uma edição entrou no meio devolve `stale` e nada é reivindicado. O OLTP tem de garantir que é uma transição
   * guardada e atômica (um UPDATE condicional por pedido), e `by` entra no histórico (#157), para duas chamadas ao mesmo tempo não
   * ganharem as duas. A reivindicação vence com o prazo (#157): a ficha é o que prende a falha e o carimbo a quem a ganhou.
   */
  claimFollowUpSend(id: number, by: string, draft: SupplierRequestText): Promise<ClaimAttempt>;
  /**
   * #157: grava o motivo da falha e solta a reivindicação, para a pessoa poder tentar de novo; `by` entra no histórico (#157).
   * #157: só vale para quem ainda detém a ficha; com a reivindicação vencida e retomada por outro, volta `lost` e não grava nada.
   */
  recordFollowUpFailure(id: number, claim: FollowUpClaim, reason: string, by: string): Promise<ClaimWrite>;
  /**
   * #157: grava o carimbo; a reivindicação fica presa depois dele, e só a falha do envio a solta.
   * #157: só vale para quem ainda detém a ficha; com a reivindicação perdida, volta `lost` e não grava nada.
   */
  recordFollowUpSent(id: number, claim: FollowUpClaim, stamp: FollowUpStamp): Promise<ClaimWrite>;
}

/** #157: o e-mail da cobrança, com a forma do MailMessage de #156, para o adaptador de #156 servir aqui. */
export type FollowUpMail = {
  readonly invoiceAccessKey: string;
  readonly supplierId: string;
  readonly requestType: RequestType;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly asks: readonly string[];
  readonly attachments: readonly { readonly filename: string; readonly contentType: string; readonly content: string }[];
  readonly dueOn: string;
};

/** #157: igual ao MailResult de #156; `reason` é da porta, nunca o texto do provedor. */
export type FollowUpMailResult =
  | { readonly ok: true; readonly channel: 'mock' | 'resend'; readonly providerMessageId: string }
  | { readonly ok: false; readonly reason: string };

export interface FollowUpMailer {
  send(message: FollowUpMail): Promise<FollowUpMailResult>;
}

/** #157: tudo de que as tarefas e os casos de uso da leitura dependem. */
export type ReplyDeps = {
  readonly inbox: SupplierInbox;
  readonly requests: ReplyRequestStore;
  readonly mailer: FollowUpMailer;
  readonly clock: Clock;
};

/** #157: a linha da lista; a leitura vai inteira, a camada da API dá os nomes do contrato. */
export type ReplyListRow = {
  readonly id: number;
  readonly invoiceAccessKey: string;
  readonly invoiceNumber: string;
  readonly supplierId: string;
  readonly supplierName: string | null;
  readonly requestType: RequestType;
  readonly totalValue: number;
  readonly dueOn: string;
  readonly status: RequestStatus;
  readonly reading: SupplierReading | null;
  readonly followUpDrafted: boolean;
  readonly followUpSent: boolean;
};

export type ReplyList = {
  readonly filter: RequestFilter;
  readonly rows: readonly ReplyListRow[];
  readonly counts: Readonly<Record<RequestFilter, number>>;
};
