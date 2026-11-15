// #72 A doca no fio: a resposta de `GET /api/doca`, nos DTOs do contrato da tela.
import { apiGet } from "./client";
import type { DockActionDto, QuantityDto } from "./contract";

export interface DockItemDto {
  sku: string | null;
  description: string;
  quantity: QuantityDto;
}

/** #43 AC-3: nota sem decisão é aguardando aprovação, nunca receber. */
export type DockStatusDto =
  | { kind: "acao"; action: DockActionDto; publishedAt: string }
  | { kind: "aguardando_aprovacao"; instrucao: string };

export interface DockRowDto {
  invoiceAccessKey: string;
  number: string;
  supplierId: string;
  items: DockItemDto[];
  status: DockStatusDto;
}

export interface DockBoardDto {
  destination: string | null;
  date: string;
  destinations: string[];
  awaiting: number;
  rows: DockRowDto[];
}

export const dockApi = {
  /** Sem destino, a API abre no primeiro destino do dia; sem data, usa hoje. */
  board(destination: string | null, signal?: AbortSignal): Promise<DockBoardDto> {
    const query = destination ? `?destino=${encodeURIComponent(destination)}` : "";
    return apiGet<DockBoardDto>(`/api/doca${query}`, { signal });
  },
};
