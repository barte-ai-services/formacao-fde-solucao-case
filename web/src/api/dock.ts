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
  /** #211 Quem decidiu a nota (o vocabulário do `timeline[]`); nulo sem aprovação. */
  decidedBy: { actor: "rule" | "person"; actor_name: string } | null;
}

export interface DockBoardDto {
  destination: string | null;
  date: string;
  destinations: string[];
  awaiting: number;
  rows: DockRowDto[];
}

export const dockApi = {
  /** #135 O recebimento na loja: mesmo formato, lido de `/api/recebimento-loja?loja=LJ-…`. */
  storeBoard(store: string | null, signal?: AbortSignal): Promise<DockBoardDto> {
    const query = store ? `?loja=${encodeURIComponent(store)}` : "";
    return apiGet<DockBoardDto>(`/api/recebimento-loja${query}`, { signal });
  },

  /** #72 Sem destino, a API abre no primeiro destino do dia; sem data, usa hoje. */
  board(destination: string | null, signal?: AbortSignal): Promise<DockBoardDto> {
    const query = destination ? `?destino=${encodeURIComponent(destination)}` : "";
    return apiGet<DockBoardDto>(`/api/doca${query}`, { signal });
  },
};
