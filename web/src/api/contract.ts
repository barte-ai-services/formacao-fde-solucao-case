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

/** #160 Os números do topo das duplicadas, da lista inteira. */
export interface DuplicatesAggregates {
  blockedAmount: { cents: Cents; text: string };
  byReason: Record<DuplicateReason, number>;
}

/** #160 `GET /api/duplicates` com `limite`: no modo paginado a lista se chama `items`, e a contagem é o `total`. */
export interface DuplicatesPageDto {
  items: DuplicateDto[];
  nextCursor: string | null;
  total: number;
  aggregates: DuplicatesAggregates;
}

/**
 * #156 O pedido ao fornecedor como `api/src/http/supplier-requests.ts` o entrega (#156). A visão do fio mora na
 * camada HTTP da API (`WireRequest`), que o `@domain` não exporta: aqui ela é espelhada à mão, e o que o domínio
 * nomeia (`RequestType`, `RequestStatus`) vem por `import type`. O dinheiro já chega em texto pt-BR.
 */
export interface SupplierRequestMoneyDto {
  text: string;
}

export interface SupplierRequestNoteDto {
  /** #156 O ND-n emitido; nulo antes da emissão. */
  number: string | null;
  /** #156 O código do fornecedor (F02), não o nome. */
  supplier: string;
  /** #156 O número da nota de origem. */
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
    /** #156 AAAA-MM-DD. */
    dueOn: string;
    subject: string;
    /** #156 O texto renderizado, o que a pessoa lê. */
    body: string;
    /** #156 O molde com `{{chave}}`: é o que o PATCH reenvia, e o servidor reconfere os números nele. */
    template: string;
  };
  asks: string[];
  /** #156 Depois da emissão; o `url` é o `return-note.pdf` da própria API (o anexo, #156), e o JSON segue em `return-note.json`. */
  attachment?: { name: string; url: string };
}

/** #156 Os motivos que a API dá quando o texto do Claude foi recusado (#156). */
export type SupplierRequestRefusal = "number_mismatch" | "invalid_shape";

export type SupplierRequestDto =
  | { status: "writing" }
  | ({ status: Extract<RequestStatus, "draft"> } & SupplierRequestContentDto)
  | ({ status: Extract<RequestStatus, "sent">; sentBy: string | null; sentAt: string | null } & SupplierRequestContentDto)
  // #156 `failure` é um código curto da porta de envio, nunca o texto do provedor.
  | ({ status: Extract<RequestStatus, "send_failed">; failure: string } & SupplierRequestContentDto)
  | { status: Extract<RequestStatus, "discarded">; discardedAt: string | null; discardedBy: string | null }
  | { status: "failed"; failure: SupplierRequestRefusal };

/** #157 O limite do molde da cobrança que a API aceita: `MAX_TEMPLATE` em api/src/http/supplier-requests.ts, conferido com `template.length` (unidades UTF-16); acima dele o PATCH volta 422. */
export const MAX_FOLLOW_UP_TEMPLATE = 20_000;

/** Toda rota por chave de acesso responde `{ request }`; sem pedido, nulo. */
export interface SupplierRequestResponseDto {
  request: SupplierRequestDto | null;
}

/**
 * #157 A leitura da resposta do fornecedor (#157) e a lista dos pedidos (#157), como `api/src/http/supplier-requests.ts` (#157) as
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
  /** #157 O trecho da resposta com ordem escondida, citado: dado, nunca instrução. */
  injectionFlag: string | null;
}

export interface ReadingRowDto {
  id: number;
  invoiceAccessKey: string;
  invoiceNumber: string;
  supplierId: string;
  supplierName: string | null;
  requestType: Extract<RequestType, "return_note">;
  /** #157 O total da nota de devolução em centavos inteiros; a tela formata. */
  totalCents: Cents;
  /** #157 AAAA-MM-DD. */
  dueOn: string;
  status: Extract<RequestStatus, "sent">;
  reading: ReadingDto | null;
  followUp: { drafted: boolean; sent: boolean };
}

export interface ReadingListDto {
  filter: ReplyFilterDto;
  requests: ReadingRowDto[];
  /** #157 Os quatro filtros, contados pelo servidor sobre todos os pedidos enviados. */
  counts: Record<ReplyFilterDto, number>;
}

export interface FollowUpDetailDto {
  drafted: boolean;
  sent: boolean;
  draft: { subject: string; body: string; template: string; asks: string[] } | null;
  sentBy: string | null;
  sentAt: string | null;
  /** #157 O código curto da última falha do envio; nunca o texto do provedor. */
  failure: string | null;
  /** #157 O novo prazo da cobrança (AAAA-MM-DD) que a regra gravou com o rascunho (#157); nulo sem rascunho ou no rascunho de antes da #157. */
  dueOn: string | null;
}

/** #157 A confirmação do documento citado na leitura atual (api #157): o documento, quem confirmou (o e-mail do Access) e quando (ISO 8601, UTC). */
export interface DocumentConfirmationDto {
  document: string;
  by: string;
  at: string;
}

/** #157 O pedido `sent` do `GET /api/supplier-requests/{accessKey}`: a visão da #156 mais a leitura e a cobrança (#157), e a confirmação do documento (#157: nula até a pessoa confirmar). */
export type SentRequestDetailDto = Extract<SupplierRequestDto, { status: "sent" }> & {
  reading: ReadingDto | null;
  documentConfirmation: DocumentConfirmationDto | null;
  followUp: FollowUpDetailDto;
};

/** #157 O que o `GET` e o `POST .../send` respondem: o pedido enviado, ou outro estado da #156 que esta tela não lê. */
export interface SupplierRequestDetailResponseDto {
  request: SentRequestDetailDto | Exclude<SupplierRequestDto, { status: "sent" }> | null;
}
