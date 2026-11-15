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
