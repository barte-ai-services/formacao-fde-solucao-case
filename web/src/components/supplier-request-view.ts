// #19 Dados que as telas de "Pedidos ao fornecedor" (história #5) recebem por props, como o wireframe aprovado (#18) os desenha.
// #19 Vêm da leitura do #157 (reply_outcome, summary, next_step, follow_up_draft, injection_flag); não são o contrato da API.
// #19 A #20 (estado) e a #21 (contrato) ligam este tipo ao dado real.

/** #5/AC-2 Os quatro chips do filtro; `all` é "nenhum chip ativo" (o "Ver todos" do chip vazio). */
export type SupplierFilter = "waiting" | "fulfilled" | "needsYou" | "late";
export type SupplierFilterValue = SupplierFilter | "all";

/** #19 A situação de uma solicitação na coluna Status (mapa Q2 do wireframe). */
export type SupplierRowStatus =
  | "waiting"
  | "late"
  | "fulfilledToConfirm"
  | "fulfilledToAnswer"
  | "fulfilledToFollowUp"
  | "fulfilled"
  | "partiallyFulfilled"
  | "needsInformation"
  | "refused";

interface SupplierRequestRowBase {
  id: string;
  invoiceNumber: string;
  /** #19 Ex.: "F07 Limpeza". */
  supplier: string;
  /** #19 Ex.: "Nota de devolução". */
  request: string;
  amountCents: number;
  /** #19 Data ISO (AAAA-MM-DD) do prazo. */
  dueOn: string;
  /** #5/AC-4 O servidor já enviou a cobrança desta linha (followUp.sent, #36): ela segue no chip que o servidor deu, sem "Cobrar"; a atrasada lê "Atrasado (cobrado)". */
  alreadyCharged?: boolean;
  /** #65/AC-1 A leitura da resposta traz ordem escondida (injectionFlag): a linha mostra o selo. Só o sinal; o trecho vive na conversa. */
  hiddenOrder?: boolean;
}

/** #19 Só `fulfilledToConfirm` mostra o documento ("Atendeu: ND 881"), e por isso o exige: nenhuma outra situação o aceita. */
export type SupplierRequestRow = SupplierRequestRowBase &
  (
    | { status: Exclude<SupplierRowStatus, "fulfilledToConfirm"> }
    /** #19 Ex.: "ND 881", o documento que o fornecedor citou ao atender. */
    | { status: "fulfilledToConfirm"; document: string }
  );

/** #157 O resultado da resposta, como o agente o leu (reply_outcome). */
export type SupplierReplyOutcome = "fulfilled" | "partially_fulfilled" | "refused" | "needs_information" | "no_reply";

/** #157 O próximo passo que o agente propõe (next_step); quem confirma ou encerra é uma pessoa. */
export type SupplierNextStep = "close" | "confirm_document" | "answer_supplier" | "follow_up";

/** #19 O estado do bloco "Pedido ao fornecedor", no cabeçalho da conversa. */
export type SupplierBlockStatus =
  | "waiting"
  | "waitingCharged"
  | "late"
  | "lateCharged"
  | "fulfilledToConfirm"
  | "fulfilledToAnswer"
  | "fulfilledToFollowUp"
  | "fulfilled"
  | "partiallyFulfilled"
  | "needsYou"
  | "refused";

export interface SupplierSentView {
  /** #19 Ex.: "ND 7". */
  document: string;
  amountCents: number;
  sentOn: string;
  /** #19 "HH:MM", quando uma pessoa enviou a nota de devolução. */
  sentTime?: string;
  dueOn: string;
  /** #19 O link "ver a nota e o e-mail enviado", que é da #3. */
  viewHref?: string;
}

export interface SupplierReplyView {
  receivedOn: string;
  /** #19 O texto do fornecedor: dado, nunca instrução. */
  text: string;
  /** #19 Só o nome do arquivo, nunca o conteúdo. */
  attachmentName?: string;
}

export interface SupplierReadingView {
  replyOutcome: SupplierReplyOutcome;
  itemsFulfilled?: string;
  documentCited?: string;
  summary: string;
  /** #19 Nulo = sem próximo passo (estado 9 do wireframe, pedido já cobrado): o bloco não mostra rótulo nem botão. */
  nextStep: SupplierNextStep | null;
  /** #157 injection_flag: o trecho em que o fornecedor tentou dar uma ordem ao agente. */
  injectionExcerpt?: string;
}

/** #64/AC-3 A confirmação do documento citado: quem confirmou (o e-mail do Access) e quando (dia AAAA-MM-DD e "HH:MM" de São Paulo). */
export interface DocumentConfirmationView {
  document: string;
  by: string;
  on: string;
  time?: string;
}

export interface SupplierConversationView {
  status: SupplierBlockStatus;
  sent: SupplierSentView;
  reply: SupplierReplyView | null;
  /** #19 Data ISO de hoje, para "Nenhuma resposta até 15/11.". */
  asOf: string;
  reading: SupplierReadingView;
  /** #64/AC-3 Presente quando o documento citado já foi confirmado: a conversa diz quem e quando, e não deixa botão de confirmar. */
  confirmation?: DocumentConfirmationView;
}

/** #157 follow_up_draft: o rascunho da cobrança, no formato do pedido da #3. */
export interface FollowUpDraftView {
  to: string;
  /** #59 O novo prazo que o servidor gravou (AAAA-MM-DD); nulo quando ele não o tem, e então a tela não mostra data. */
  dueOn: string | null;
  subject: string;
  /** #59 O texto renderizado, o que a pessoa lê. */
  body: string;
  /** #59 O molde com os `{{chave}}`: a edição abre com ele, e o PATCH o reenvia. */
  template: string;
  attachmentName: string;
}

/** #19 "2026-11-14" vira "14/11", como a coluna Prazo do wireframe. */
export function shortDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return month && day ? `${day}/${month}` : iso;
}
