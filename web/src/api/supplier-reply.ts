/**
 * #21 O fio da lista "Pedidos ao fornecedor" (#5) e da leitura da resposta (#4): `api/src/http/supplier-requests.ts` (#36).
 * A lista vem por filtro, com as contagens dos quatro filtros calculadas pelo servidor; a gaveta lê o pedido pela chave de acesso,
 * "Cobrar" envia pelo `POST .../send`, "Editar" guarda o texto pelo `PATCH .../follow-up` (#59) e "Confirmar documento" grava a confirmação pelo `POST .../confirm-document` (#64). O erro de uma chamada vira um motivo fechado (`SupplierReplyReason`): o corpo da resposta não sai daqui.
 */
import { ApiError, apiGet, apiPatch, apiPost } from "./client";
import type { ReadingListDto, ReplyFilterDto, SentRequestDetailDto, SupplierRequestDetailResponseDto } from "./contract";

/** #21 O prazo do envio da cobrança, como o do envio do pedido (#17): a chamada parada termina, não fica pendurada. */
export const FOLLOW_UP_SEND_TIMEOUT_MS = 30_000;

/** #59 O prazo do salvamento da cobrança editada: o servidor reconfere o texto contra o catálogo antes de gravar; a chamada parada termina. */
export const FOLLOW_UP_SAVE_TIMEOUT_MS = 20_000;

/** #59 Os motivos fechados de um salvamento recusado: 422 (texto que não confere), 409 (o pedido mudou) e o resto; o corpo da resposta não entra. */
export type SaveFailure = "invalid" | "conflict" | "unknown";

/** #59 O que o salvamento devolve: o pedido como ficou, e se o servidor recusou por conflito (já enviado, envio em curso, sem rascunho, texto trocado no meio). */
export interface SavedFollowUp {
  kind: "saved" | "conflict";
  detail: SentRequestDetailDto;
}

/** #64 O prazo da confirmação do documento: o servidor só grava a confirmação (sem e-mail nem catálogo), mas a chamada parada termina, como as da #17 e da #59. */
export const CONFIRM_DOCUMENT_TIMEOUT_MS = 20_000;

/** #64 O que a confirmação devolve: o pedido como ficou, e se o servidor recusou por conflito (já confirmado, mudou no meio, sem documento a confirmar); em ambos, o pedido é o relido do servidor. */
export interface ConfirmedDocument {
  kind: "confirmed" | "conflict";
  detail: SentRequestDetailDto;
}

/** #64 O motivo fechado de um 409 da confirmação: "já confirmado" (o servidor o diz) ou qualquer outro (mudou, sem documento a confirmar, motivo que a tela não conhece). */
export type ConfirmConflictReason = "already_confirmed" | "other";

/**
 * #64 O 409 da confirmação veio, mas a releitura do pedido falhou: a tela já sabe o motivo fechado do 409 e não sabe o estado do pedido.
 * O texto do 409 e o do erro da releitura não ficam aqui (layer-exposure).
 */
export class ConfirmRereadFailed extends Error {
  constructor(readonly reason: ConfirmConflictReason) {
    super("a releitura do pedido falhou depois de um conflito na confirmação");
    this.name = "ConfirmRereadFailed";
  }
}

/** #21 Os motivos fechados de uma chamada falha; é o que a tela sabe de um erro (layer-exposure). */
export type SupplierReplyReason = "unauthorized" | "not_found" | "conflict" | "unavailable" | "unknown";

/** #21 O motivo de um erro: só o status decide, nunca o texto nem o corpo da resposta. */
export function supplierReplyReason(error: unknown): SupplierReplyReason {
  if (!(error instanceof ApiError)) return "unknown";
  if (error.isUnauthorized) return "unauthorized";
  if (error.status === 404) return "not_found";
  if (error.status === 409 || error.status === 422) return "conflict";
  if (error.status === 0 || error.status === 502 || error.status === 503) return "unavailable";
  return "unknown";
}

/** #21 O pedido da gaveta tem de estar `sent`, com a leitura e a cobrança; qualquer outra forma é falha de carga. */
function sentOf(response: SupplierRequestDetailResponseDto): SentRequestDetailDto {
  const request = response.request;
  if (request === null || request === undefined || request.status !== "sent" || !("followUp" in request)) {
    throw new ApiError(0, null, "a API não devolveu o pedido enviado");
  }
  return request;
}

const pathOf = (accessKey: string, action = ""): string => `/api/supplier-requests/${encodeURIComponent(accessKey)}${action}`;

/**
 * #5/AC-4 O envio devolve o pedido como ficou. Um 409 (já enviado, envio em curso, sem rascunho; #36) não é falha desconhecida: relê o pedido
 * e devolve como o servidor o tem, e é o `followUp.sent` dele que diz se a cobrança saiu. O corpo do 409 não é lido (layer-exposure).
 */
async function sendFollowUpOf(accessKey: string): Promise<SentRequestDetailDto> {
  try {
    return sentOf(await apiPost<SupplierRequestDetailResponseDto>(pathOf(accessKey, "/send"), {}, { timeoutMs: FOLLOW_UP_SEND_TIMEOUT_MS }));
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    return sentOf(await apiGet<SupplierRequestDetailResponseDto>(pathOf(accessKey)));
  }
}

/** #59 O motivo de um salvamento recusado: só o status decide (422 texto inválido, 409 conflito), nunca o texto nem o corpo da resposta. */
export function saveFailureOf(error: unknown): SaveFailure {
  if (!(error instanceof ApiError)) return "unknown";
  if (error.status === 422) return "invalid";
  if (error.status === 409) return "conflict";
  return "unknown";
}

/**
 * #59 Salva o molde editado da cobrança (PATCH .../follow-up, #58): o servidor revalida os números contra o catálogo e devolve o pedido com o rascunho novo.
 * #59 Um 422 falha como erro (o texto anterior fica no servidor); um 409 relê o pedido, como o envio, e o devolve como conflito. O corpo não é lido (layer-exposure).
 */
async function saveFollowUpOf(accessKey: string, template: string): Promise<SavedFollowUp> {
  try {
    return { kind: "saved", detail: sentOf(await apiPatch<SupplierRequestDetailResponseDto>(pathOf(accessKey, "/follow-up"), { template }, { timeoutMs: FOLLOW_UP_SAVE_TIMEOUT_MS })) };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    return { kind: "conflict", detail: sentOf(await apiGet<SupplierRequestDetailResponseDto>(pathOf(accessKey))) };
  }
}

/**
 * #64/AC-2 A pessoa confirma o documento que o fornecedor citou (POST .../confirm-document, #63): o corpo é vazio, quem confirma vem do Access.
 * #64 Um 409 (already_confirmed, stale, not_confirm_document) não é falha desconhecida: relê o pedido e o devolve como conflito, e o `documentConfirmation` dele diz se a confirmação existe. Do corpo do 409 só se lê o `reason`, e como valor fechado (layer-exposure).
 * #64 Se a releitura falhar, o erro é `ConfirmRereadFailed`, com esse motivo fechado.
 */
async function confirmDocumentOf(accessKey: string): Promise<ConfirmedDocument> {
  try {
    return { kind: "confirmed", detail: sentOf(await apiPost<SupplierRequestDetailResponseDto>(pathOf(accessKey, "/confirm-document"), {}, { timeoutMs: CONFIRM_DOCUMENT_TIMEOUT_MS })) };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    // #64 O motivo do 409 vira um de dois valores fechados antes de a releitura tentar: se ela falhar, a tela ainda sabe se o servidor disse "já confirmado".
    const reason: ConfirmConflictReason = error.reason === "already_confirmed" ? "already_confirmed" : "other";
    try {
      return { kind: "conflict", detail: sentOf(await apiGet<SupplierRequestDetailResponseDto>(pathOf(accessKey))) };
    } catch {
      throw new ConfirmRereadFailed(reason);
    }
  }
}

export interface SupplierReplyApi {
  /** #21 As linhas do filtro e as contagens dos quatro filtros. */
  list: (filter: ReplyFilterDto, signal: AbortSignal) => Promise<ReadingListDto>;
  /** #21 O pedido enviado da gaveta, com a leitura e o rascunho da cobrança. */
  detail: (accessKey: string, signal: AbortSignal) => Promise<SentRequestDetailDto>;
  /** #21 Envia a cobrança do rascunho que o servidor guarda; devolve o pedido como ficou (com `followUp.sent` ou `followUp.failure`). */
  sendFollowUp: (accessKey: string) => Promise<SentRequestDetailDto>;
  /** #59 Salva o molde editado da cobrança (com os `{{chave}}`); o servidor reconfere os números e guarda o texto, e o envio manda o que ele guarda. */
  saveFollowUp: (accessKey: string, template: string) => Promise<SavedFollowUp>;
  /** #64 Confirma o documento citado na leitura; devolve o pedido como ficou, com `documentConfirmation` (quem e quando), ou relido num conflito. */
  confirmDocument: (accessKey: string) => Promise<ConfirmedDocument>;
}

export const supplierReplyApi: SupplierReplyApi = {
  list: (filter, signal) => apiGet<ReadingListDto>(`/api/supplier-requests?status=${filter}`, { signal }),
  detail: async (accessKey, signal) => sentOf(await apiGet<SupplierRequestDetailResponseDto>(pathOf(accessKey), { signal })),
  sendFollowUp: sendFollowUpOf,
  saveFollowUp: saveFollowUpOf,
  confirmDocument: confirmDocumentOf,
};
