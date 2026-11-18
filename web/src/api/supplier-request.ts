/**
 * #156 O fio do pedido ao fornecedor (`api/src/http/supplier-requests.ts`, #156): as rotas são pela chave de acesso
 * da nota de origem. `supplierRequestApi` devolve o `SupplierRequestDto` do fio, que cabe na `SupplierRequestPort`
 * do estado (#156, web/src/approval/supplier-request-state.ts): quem declara a porta é quem a usa, e o fio não importa a tela.
 */
import { ApiError, apiGet, apiPatch, apiPost } from "./client";
import type { SupplierRequestDto, SupplierRequestResponseDto } from "./contract";

/** #156 As chamadas do fio; cada ação devolve o pedido como a API o deixou. */
export interface SupplierRequestApi {
  load: (accessKey: string, signal: AbortSignal) => Promise<SupplierRequestDto | null>;
  send: (accessKey: string) => Promise<SupplierRequestDto>;
  resend: (accessKey: string) => Promise<SupplierRequestDto>;
  discard: (accessKey: string) => Promise<SupplierRequestDto>;
  redo: (accessKey: string) => Promise<SupplierRequestDto>;
  /** #156 Salva o molde do texto (com os `{{chave}}`); o servidor reconfere os números. */
  saveTemplate: (accessKey: string, template: string) => Promise<SupplierRequestDto>;
}

const pathOf = (accessKey: string, action = ""): string => `/api/supplier-requests/${encodeURIComponent(accessKey)}${action}`;

/** #156 A API garante `request` em toda escrita; faltando, a ação falha em vez de a tela supor um estado. */
function requestOf(response: SupplierRequestResponseDto): SupplierRequestDto {
  if (response.request === null || response.request === undefined) throw new ApiError(0, null, "a API não devolveu o pedido");
  return response.request;
}

/**
 * #156 Prazos por ação: o redo espera o Claude (até 45 s, api/src/claude/client.ts); o envio emite a nota, grava e manda o
 * e-mail. As demais ações usam o prazo padrão do cliente.
 */
export const SEND_TIMEOUT_MS = 30_000;
export const REDO_TIMEOUT_MS = 50_000;

const post = async (accessKey: string, action: string, options: { timeoutMs?: number } = {}): Promise<SupplierRequestDto> =>
  requestOf(await apiPost<SupplierRequestResponseDto>(pathOf(accessKey, action), {}, options));

export const supplierRequestApi: SupplierRequestApi = {
  // #156 O contrato responde 200 com `request` nulo quando a nota não tem pedido; qualquer erro é falha de carga.
  load: async (accessKey, signal) => (await apiGet<SupplierRequestResponseDto>(pathOf(accessKey), { signal })).request ?? null,
  send: (accessKey) => post(accessKey, "/send", { timeoutMs: SEND_TIMEOUT_MS }),
  resend: (accessKey) => post(accessKey, "/resend", { timeoutMs: SEND_TIMEOUT_MS }),
  discard: (accessKey) => post(accessKey, "/discard"),
  redo: (accessKey) => post(accessKey, "/redo", { timeoutMs: REDO_TIMEOUT_MS }),
  saveTemplate: async (accessKey, template) => requestOf(await apiPatch<SupplierRequestResponseDto>(pathOf(accessKey), { template })),
};
