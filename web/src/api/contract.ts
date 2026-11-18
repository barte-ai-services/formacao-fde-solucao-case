/**
 * Os DTOs do fio entre o Worker e a tela, tipados pelo contrato do domínio (F4, `api/src/domain`).
 * O domínio tem classes (Money, Quantity, Invoice, Proposal…); o fio não: aqui só há dado simples,
 * que o JSON leva e traz. Os nomes e os valores fechados (classificação, ação na doca, nível,
 * estados) vêm do domínio por `import type`, então mudar o domínio quebra a tela no typecheck.
 *
 * Dinheiro viaja em centavos inteiros (`*Cents`), como o `Money` guarda. Nunca ponto flutuante.
 */
import type {
  ApprovalLevel,
  Classification,
  DockAction,
  DossierField,
  Evidence,
  EvidenceSource,
  ExceptionCode,
  InvoiceState,
  PartialLine,
  ProposalState,
  RequestStatus,
  RequestType,
  TitleState,
  Unit,
} from "@domain";

export type {
  ApprovalLevel,
  Classification,
  DossierField,
  Evidence,
  EvidenceSource,
  ExceptionCode,
  InvoiceState,
  ProposalState,
  TitleState,
  Unit,
};

/** #130 O dossiê pedido na gaveta, ainda em geração (`api/src/dossier/proposal-field.ts`). */
export interface DossierGeneratingDto {
  status: "generating";
  /** #38 `event`: começou quando a nota chegou; #130 `on_demand`: a pessoa pediu na gaveta. */
  trigger: "event" | "on_demand";
  requestedBy: string;
  requestedAt: string;
}

/** #130 O campo `dossier` da proposta na gaveta: pronto, indisponível ou em geração. */
export type ProposalDossierDto = DossierField | DossierGeneratingDto;

/** Toda classificação que é uma divergência: as oito exceções e a não catalogada. */
export type DivergenceCode = Exclude<Classification, "MATCH">;

/** `GET /me`. `email` é nulo para um service token do Access, que não tem e-mail. */
export interface MeDto {
  email: string | null;
}

/** Centavos inteiros de real. */
export type Cents = number;

export interface QuantityDto {
  amount: number;
  unit: Unit;
}

export type EvidenceDto = Evidence;

/** Uma exceção encontrada na conferência, com as evidências que a sustentam. */
export interface DivergenceDto {
  classification: DivergenceCode;
  /** #128: o código e o nome do glossário, como a API manda; a tela não traduz. */
  exceptionCode: DivergenceCode;
  exceptionName: string;
  skus: string[];
  evidence: EvidenceDto[];
}

export interface PartialLineDto {
  sku: string;
  quantity: QuantityDto;
  disposition: PartialLine["disposition"];
}

/** O tipo da ação, sem as linhas: `receber`, `receber_parcial` ou `recusar`. */
export type DockActionKind = DockAction["kind"];

/** O que a doca faz com a carga. Só o receber parcial leva linhas. */
export type DockActionDto =
  | { kind: Exclude<DockActionKind, "receber_parcial"> }
  | { kind: Extract<DockActionKind, "receber_parcial">; lines: PartialLineDto[] };

export interface InvoiceItemDto {
  supplierCode: string;
  sku: string | null;
  description: string;
  quantity: QuantityDto;
  unitPriceCents: Cents;
  totalCents: Cents;
}

/** A nota fiscal, com o resultado da conferência. */
export interface InvoiceDto {
  accessKey: string;
  number: string;
  series: string;
  supplierId: string;
  store: string;
  issuedOn: string;
  purchaseOrderRef: string | null;
  entryChannel: string;
  items: InvoiceItemDto[];
  totalCents: Cents;
  state: InvoiceState;
  classification: Classification;
  divergences: DivergenceDto[];
}

/** A proposta do agente para uma nota. */
export interface ProposalDto {
  invoiceAccessKey: string;
  classification: Classification;
  dockAction: DockActionDto;
  level: ApprovalLevel;
  amountAtRiskCents: Cents;
  justification: string;
  state: ProposalState;
  /** #68: o dossiê do Claude, já conferido contra o banco; sem ele, o aviso de por quê (#38/AC-4). */
  dossier: DossierField;
}

/** O título a pagar da nota, no contas a pagar. */
export interface TitleDto {
  invoiceAccessKey: string;
  dueOn: string;
  amountCents: Cents;
  state: TitleState;
}

/**
 * Os dois motivos de uma duplicidade (E6). O domínio tem o mesmo tipo (`DuplicateReason`, em
 * `checks/e6-duplicidade.ts`), mas o índice dele não o exporta; por isso a união fica aqui.
 */
export type DuplicateReason = "titulo_lancado" | "ordem_sem_saldo"; // ADR-002

/** A nota duplicada: a que chegou e teve o título bloqueado. */
export interface DuplicateInvoiceDto {
  accessKey: string;
  number: string;
  supplierId: string;
  issuedOn: string;
  totalCents: Cents;
  /** O total já formatado em reais pelo Worker, ex. "R$ 1.209,60". */
  total: string;
}

/** O título original que a nota duplicada cobra de novo. */
export interface OriginalInvoiceDto {
  accessKey: string;
  number: string;
  /** A situação do título original, ex. `lançada` ou `paga`. O fio pode trazer outra. */
  status: string;
}

/** Uma duplicidade: a nota nova, a original (nula quando só a ordem não tem saldo) e o valor barrado. */
export interface DuplicateDto {
  duplicate: DuplicateInvoiceDto;
  original: OriginalInvoiceDto | null;
  reason: DuplicateReason;
  /** O estado real do título da nota duplicada no contas a pagar; nulo quando ainda não há título. */
  titleState: TitleState | null;
  blockedAmountCents: Cents;
  /** O valor barrado já formatado em reais. */
  blockedAmount: string;
}

/** `GET /api/duplicates`. */
export interface DuplicatesResponseDto {
  duplicates: DuplicateDto[];
  count: number;
}

/**
 * #17 O pedido ao fornecedor como `api/src/http/supplier-requests.ts` o entrega (#13). A visão do fio mora na
 * camada HTTP da API (`WireRequest`), que o `@domain` não exporta: aqui ela é espelhada à mão, e o que o domínio
 * nomeia (`RequestType`, `RequestStatus`) vem por `import type`. O dinheiro já chega em texto pt-BR.
 */
export interface SupplierRequestMoneyDto {
  text: string;
}

export interface SupplierRequestNoteDto {
  /** #17 O ND-n emitido; nulo antes da emissão. */
  number: string | null;
  /** #17 O código do fornecedor (F02), não o nome. */
  supplier: string;
  /** #17 O número da nota de origem. */
  reference: string;
  lines: { description: string; quantity: string; unitPrice: SupplierRequestMoneyDto; total: SupplierRequestMoneyDto }[];
  total: SupplierRequestMoneyDto;
}

interface SupplierRequestContentDto {
  invoiceAccessKey: string;
  requestType: RequestType;
  returnNote: SupplierRequestNoteDto;
  email: {
    to: string;
    /** #17 AAAA-MM-DD. */
    dueOn: string;
    subject: string;
    /** #17 O texto renderizado, o que a pessoa lê. */
    body: string;
    /** #17 O molde com `{{chave}}`: é o que o PATCH reenvia, e o servidor reconfere os números nele. */
    template: string;
  };
  asks: string[];
  /** #17 Depois da emissão; o `url` é o `return-note.pdf` da própria API (o anexo, #57), e o JSON segue em `return-note.json`. */
  attachment?: { name: string; url: string };
}

/** #17 Os motivos que a API dá quando o texto do Claude foi recusado (#2/AC-7). */
export type SupplierRequestRefusal = "number_mismatch" | "invalid_shape";

export type SupplierRequestDto =
  | { status: "writing" }
  | ({ status: Extract<RequestStatus, "draft"> } & SupplierRequestContentDto)
  | ({ status: Extract<RequestStatus, "sent">; sentBy: string | null; sentAt: string | null } & SupplierRequestContentDto)
  // #17 `failure` é um código curto da porta de envio, nunca o texto do provedor.
  | ({ status: Extract<RequestStatus, "send_failed">; failure: string } & SupplierRequestContentDto)
  | { status: Extract<RequestStatus, "discarded">; discardedAt: string | null; discardedBy: string | null }
  | { status: "failed"; failure: SupplierRequestRefusal };

/** #65/AC-5 O limite do molde da cobrança que a API aceita: `MAX_TEMPLATE` em api/src/http/supplier-requests.ts, conferido com `template.length` (unidades UTF-16); acima dele o PATCH volta 422. */
export const MAX_FOLLOW_UP_TEMPLATE = 20_000;

/** Toda rota por chave de acesso responde `{ request }`; sem pedido, nulo. */
export interface SupplierRequestResponseDto {
  request: SupplierRequestDto | null;
}

/**
 * #21 A leitura da resposta do fornecedor (#4) e a lista dos pedidos (#5), como `api/src/http/supplier-requests.ts` (#36) as
 * entrega. Os valores fechados são os do cabeçalho daquele arquivo; o texto de um erro da API nunca entra aqui.
 */
export type ReplyFilterDto = "awaiting" | "answered" | "needs_you" | "overdue"; // ADR-002
export type ReplyOutcomeDto = "fulfilled" | "partially_fulfilled" | "refused" | "needs_information" | "no_reply"; // ADR-002
export type NextStepDto = "close" | "confirm_document" | "answer_supplier" | "follow_up"; // ADR-002

export interface ReadingDto {
  replyOutcome: ReplyOutcomeDto;
  fulfilledAsks: string[];
  supplierDocument: string | null;
  summary: string;
  nextStep: NextStepDto;
  /** #21 O trecho da resposta com ordem escondida, citado: dado, nunca instrução. */
  injectionFlag: string | null;
}

export interface ReadingRowDto {
  id: number;
  invoiceAccessKey: string;
  invoiceNumber: string;
  supplierId: string;
  supplierName: string | null;
  requestType: Extract<RequestType, "return_note">;
  /** #21 O total da nota de devolução em centavos inteiros; a tela formata. */
  totalCents: Cents;
  /** #21 AAAA-MM-DD. */
  dueOn: string;
  status: Extract<RequestStatus, "sent">;
  reading: ReadingDto | null;
  followUp: { drafted: boolean; sent: boolean };
}

export interface ReadingListDto {
  filter: ReplyFilterDto;
  requests: ReadingRowDto[];
  /** #21 Os quatro filtros, contados pelo servidor sobre todos os pedidos enviados. */
  counts: Record<ReplyFilterDto, number>;
}

export interface FollowUpDetailDto {
  drafted: boolean;
  sent: boolean;
  draft: { subject: string; body: string; template: string; asks: string[] } | null;
  sentBy: string | null;
  sentAt: string | null;
  /** #21 O código curto da última falha do envio; nunca o texto do provedor. */
  failure: string | null;
  /** #59 O novo prazo da cobrança (AAAA-MM-DD) que a regra gravou com o rascunho (#58); nulo sem rascunho ou no rascunho de antes da #58. */
  dueOn: string | null;
}

/** #64 A confirmação do documento citado na leitura atual (api #63/AC-3): o documento, quem confirmou (o e-mail do Access) e quando (ISO 8601, UTC). */
export interface DocumentConfirmationDto {
  document: string;
  by: string;
  at: string;
}

/** #21 O pedido `sent` do `GET /api/supplier-requests/{accessKey}`: a visão da #13 mais a leitura e a cobrança (#36), e a confirmação do documento (#64: nula até a pessoa confirmar). */
export type SentRequestDetailDto = Extract<SupplierRequestDto, { status: "sent" }> & {
  reading: ReadingDto | null;
  documentConfirmation: DocumentConfirmationDto | null;
  followUp: FollowUpDetailDto;
};

/** #21 O que o `GET` e o `POST .../send` respondem: o pedido enviado, ou outro estado da #13 que esta tela não lê. */
export interface SupplierRequestDetailResponseDto {
  request: SentRequestDetailDto | Exclude<SupplierRequestDto, { status: "sent" }> | null;
}
