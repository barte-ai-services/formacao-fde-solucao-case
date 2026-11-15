/**
 * #63 O fio da aprovação: a fila, a proposta, aprovar e alterar, e a lista do dia
 * (`api/src/http/approval.ts`). Dinheiro vem em centavos, com o texto já formatado pelo Worker.
 */
import { apiGet, apiPost } from "./client";
import type {
  ApprovalLevel,
  Classification,
  DivergenceDto,
  DockActionDto,
  DossierField,
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

export interface QueueDto {
  approver: { email: string | null; level: PersonLevel | null };
  items: QueueItemDto[];
}

export interface ApprovalDto {
  approver: string;
  approverLevel: ApprovalLevel;
  dockAction: DockActionDto;
  justification: string;
  decidedOn: string;
}

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
  dossier: DossierField;
}

export interface TodayDto {
  day: string;
  items: {
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
  }[];
  total: { cents: number };
}

export interface DecisionResultDto {
  approval: ApprovalDto;
  title: { state: TitleState; amount: MoneyDto };
}

export const approvalApi = {
  queue: (signal?: AbortSignal) => apiGet<QueueDto>("/api/fila", { signal }),
  proposal: (key: string, signal?: AbortSignal) =>
    apiGet<ProposalDetailDto>(`/api/propostas/${encodeURIComponent(key)}`, { signal }),
  approve: (key: string) => apiPost<DecisionResultDto>(`/api/propostas/${encodeURIComponent(key)}/aprovar`, {}),
  alter: (key: string, dockAction: DockActionDto, justification: string) =>
    apiPost<DecisionResultDto>(`/api/propostas/${encodeURIComponent(key)}/alterar`, { dockAction, justification }),
  today: (signal?: AbortSignal) => apiGet<TodayDto>("/api/hoje", { signal }),
};
