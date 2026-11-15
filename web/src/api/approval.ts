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
  dossier: ProposalDossierDto; // #130 também `generating`, quando a pessoa pediu na gaveta
  /** #211 Os passos da nota, em ordem. */
  timeline?: TimelineStepDto[];
}

/** #211 Um passo de "Como esta nota andou", montado pela API do que o banco guarda. */
export interface TimelineStepDto {
  at: string;
  kind: string;
  step: string;
  actor: "system" | "rule" | "claude" | "engine" | "person";
  actor_name: string;
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
