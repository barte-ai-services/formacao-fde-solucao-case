// #160 As duplicadas no fio paginado: um bloco de `GET /api/duplicates` com `limite`, nos DTOs do contrato.
import type { Block } from "../components/paged-list-state";
import type { DuplicateDto, DuplicatesAggregates, DuplicatesPageDto } from "./contract";
import { blockOf, getPage } from "./paged";

export type DuplicateRow = DuplicateDto & { key: string };

export const duplicatesApi = {
  /** #160 Um bloco das duplicadas; a chave da linha é a da nota duplicada. */
  page: async (cursor: string | null, signal: AbortSignal): Promise<Block<DuplicateRow, DuplicatesAggregates>> =>
    blockOf(await getPage<DuplicatesPageDto>("/api/duplicates", [], cursor, signal), (entry) => entry.duplicate.accessKey),
};
