/**
 * #63 O fio da aprovação: a fila, a proposta, aprovar e alterar, e a lista do dia
 * (`api/src/http/approval.ts`). Dinheiro vem em centavos, com o texto já formatado pelo Worker.
 */
import type { Block } from "../components/paged-list-state";
import { apiGet, apiPost } from "./client";
import { blockOf, getPage, type PageDto } from "./paged";
import type {
  ApprovalLevel,
  Classification,
  DivergenceDto,
  DockActionDto,
  DossierGeneratingDto,
  ProposalDossierDto,
  ProposalState,
  TitleState,
  Unit,
} from "./contract";

export interface MoneyDto {
  cents: number;
  text: string;
}

/** Os níveis de quem aprova: regra e bloqueio não são pessoas. */
export type PersonLevel = Extract<ApprovalLevel, "analista" | "coordenacao" | "diretoria">;

export interface QueueItemDto {
  invoiceAccessKey: string;
  number: string;
  supplierId: string;
  store: string;
  issuedOn: string;
  total: MoneyDto;
  classification: Classification;
  exceptionCode: Classification;
  exceptionName: string;
  level: ApprovalLevel;
  line: number;
  reason: string;
  requiredApproverLevel: ApprovalLevel;
  amountAtRisk: MoneyDto;
  dockAction: DockActionDto;
  state: ProposalState;
  canApprove: boolean;
}

/** #160 Os números do topo da fila, da fila inteira e iguais com ou sem o filtro e em qualquer página. */
export interface QueueAggregates {
  /** #160 O chip "Todas". */
  all: number;
  /** #160 O chip "Minhas": as que a pessoa pode aprovar. */
  approvable: number;
  amountAtRisk: MoneyDto;
  blocked: number;
}

/** #160 Uma página da fila (`GET /api/fila` com `limite`); `approver` é o contexto da lista. */
export interface QueuePageDto extends PageDto<QueueItemDto, QueueAggregates> {
  approver: { email: string | null; level: PersonLevel | null };
}

export type QueueRow = QueueItemDto & { key: string };

export interface ApprovalDto {
  approver: string;
  approverLevel: ApprovalLevel;
  dockAction: DockActionDto;
  justification: string;
  decidedOn: string;
}

/** #231 A auditoria da nota como a API a devolve (`auditView` em api/src/http/approval.ts); nula enquanto a nota não foi auditada. */
export type AuditDto =
  | { status: "nao_auditada"; reason: "claude_falhou" | "erro_de_tool" | "sem_auditoria"; refusals: readonly unknown[] } // ADR-002
  | {
      status: "auditada";
      classification: Classification;
      dockAction: { kind: DockActionDto["kind"] };
      routing: ApprovalLevel;
      justification: string;
      amountAtRisk: MoneyDto | null;
      model: string;
      auditedAt: string;
      agreement: { agrees: true } | { agrees: false; differs: readonly ("classification" | "dockAction" | "routing")[] };
      raisedLevel: ApprovalLevel | null;
      injectionFlag: string | null;
      refusals: readonly unknown[];
    };

export interface ProposalDetailDto extends QueueItemDto {
  justification: string;
  items: {
    supplierCode: string;
    sku: string | null;
    description: string;
    quantity: { amount: number; unit: Unit };
    /** #176 A mesma quantidade na unidade de estoque (12 CX = 48 UN); nula se o cadastro não tem o fator. */
    stockQuantity?: { amount: number; unit: Unit } | null;
    unitPrice: MoneyDto;
    total: MoneyDto;
  }[];
  divergences: DivergenceDto[];
  title: { state: TitleState; amount: MoneyDto; dueOn: string };
  approval: ApprovalDto | null;
  /** #68: o dossiê do Claude, já conferido pelo Worker; sem ele, o motivo e o aviso (#38/AC-4). */
  dossier: ProposalDossierDto; // #130 também `generating`, quando a pessoa pediu na gaveta
  /** #211 Os passos da nota, em ordem. */
  timeline?: TimelineStepDto[];
  /** #231 A auditoria: nula é "pendente"; ausente (resposta sem o campo) o bloco não mostra. */
  audit?: AuditDto | null;
}

/** #211 Um passo de "Como esta nota andou", montado pela API do que o banco guarda. */
export interface TimelineStepDto {
  at: string;
  kind: string;
  step: string;
  actor: "system" | "rule" | "claude" | "engine" | "person";
  actor_name: string;
}

/** #160 Quem aprovou o título da lista do dia, como a API diz: a regra, o motor, uma pessoa; nulo sem aprovação. */
export type ApprovedBy = "rule" | "engine" | "person" | null;

export interface TodayItemDto {
  invoiceAccessKey: string;
  number: string;
  supplierId: string;
  amount: MoneyDto;
  invoiceTotal: MoneyDto;
  dueOn: string;
  exceptionCode: Classification;
  exceptionName: string;
  dockAction: DockActionDto["kind"];
  approver: string | null;
  approvedBy: ApprovedBy;
}

/** #160 Os números do topo da lista do dia; `total` da resposta é a contagem de títulos. */
export interface TodayAggregates {
  toPay: MoneyDto;
  approvedByRule: number;
}

/** #160 Uma página da lista do dia (`GET /api/hoje` com `limite`). */
export interface TodayPageDto extends PageDto<TodayItemDto, TodayAggregates> {
  day: string;
}

export type TodayRow = TodayItemDto & { key: string };

export interface DecisionResultDto {
  approval: ApprovalDto;
  title: { state: TitleState; amount: MoneyDto };
}

export const approvalApi = {
  /** #160 Um bloco da fila; `approvableOnly` é o chip "Minhas" (D1), pedido à API e não filtrado na tela. */
  queuePage: async (approvableOnly: boolean, cursor: string | null, signal: AbortSignal): Promise<Block<QueueRow, QueueAggregates>> => {
    const filters: [string, string][] = approvableOnly ? [["pode_aprovar", "1"]] : []; // ADR-006
    return blockOf(await getPage<QueuePageDto>("/api/fila", filters, cursor, signal), (item) => item.invoiceAccessKey); // ADR-004
  },
  proposal: (key: string, signal?: AbortSignal) =>
    apiGet<ProposalDetailDto>(`/api/propostas/${encodeURIComponent(key)}`, { signal }),
  approve: (key: string) => apiPost<DecisionResultDto>(`/api/propostas/${encodeURIComponent(key)}/aprovar`, {}),
  alter: (key: string, dockAction: DockActionDto, justification: string) =>
    apiPost<DecisionResultDto>(`/api/propostas/${encodeURIComponent(key)}/alterar`, { dockAction, justification }),
  /** #160 Um bloco da lista do dia. */
  todayPage: async (cursor: string | null, signal: AbortSignal): Promise<Block<TodayRow, TodayAggregates>> =>
    blockOf(await getPage<TodayPageDto>("/api/hoje", [], cursor, signal), (item) => item.invoiceAccessKey),
  requestDossier,
};

/** #130 O 202 do pedido: o Worker responde em snake_case; a tela usa a forma do GET da proposta. */
interface DossierRequestedBody {
  status: "generating";
  trigger: "on_demand";
  requested_by: string;
  requested_at: string;
}

/**
 * #130 `POST /api/propostas/:chave/dossie`: pede o dossiê ao Claude só para esta proposta. 202 vira o estado
 * Gerando; 409 (já em geração) e 429 (limite) chegam como `ApiError`.
 */
export async function requestDossier(accessKey: string): Promise<DossierGeneratingDto> {
  const body = await apiPost<DossierRequestedBody>(`/api/propostas/${encodeURIComponent(accessKey)}/dossie`, {});
  return { status: "generating", trigger: "on_demand", requestedBy: body.requested_by, requestedAt: body.requested_at };
}
