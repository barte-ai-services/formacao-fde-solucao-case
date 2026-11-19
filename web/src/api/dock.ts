// #72 A doca no fio: a resposta de `GET /api/doca`, nos DTOs do contrato da tela.
import type { Block } from "../components/paged-list-state";
import type { DockActionDto, QuantityDto } from "./contract";
import { blockOf, getPage, type PageDto } from "./paged";

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

/** #160 Os números do topo da doca e o que a resposta diz do destino; `awaiting` é do destino inteiro. */
export interface DockAggregates {
  awaiting: number;
}

/** #160 Uma página da doca ou da loja (`GET /api/doca`, `GET /api/recebimento-loja` com `limite`); o destino e a data são o contexto da lista. */
export interface DockPageDto extends PageDto<DockRowDto, DockAggregates> {
  destination: string | null;
  date: string;
  destinations: string[];
}

export type DockRow = DockRowDto & { key: string };

/** #160 O que a tela lê do primeiro bloco além das linhas: os agregados e o destino com a lista de destinos (o seletor). */
export interface DockBoardAggregates extends DockAggregates {
  destination: string | null;
  destinations: string[];
}

async function boardPage(path: string, filter: [string, string][], cursor: string | null, signal: AbortSignal): Promise<Block<DockRow, DockBoardAggregates>> {
  const page = await getPage<DockPageDto>(path, filter, cursor, signal);
  return { ...blockOf(page, (row) => row.invoiceAccessKey), aggregates: { ...page.aggregates, destination: page.destination, destinations: page.destinations } };
}

export const dockApi = {
  /** #135 O recebimento na loja: mesmo formato, lido de `/api/recebimento-loja?loja=LJ-…`. */
  storePage: (store: string | null, cursor: string | null, signal: AbortSignal): Promise<Block<DockRow, DockBoardAggregates>> =>
    boardPage("/api/recebimento-loja", store ? [["loja", store]] : [], cursor, signal),

  /** #72 Sem destino, a API abre no primeiro destino do dia; sem data, usa hoje. */
  boardPage: (destination: string | null, cursor: string | null, signal: AbortSignal): Promise<Block<DockRow, DockBoardAggregates>> =>
    boardPage("/api/doca", destination ? [["destino", destination]] : [], cursor, signal),
};
