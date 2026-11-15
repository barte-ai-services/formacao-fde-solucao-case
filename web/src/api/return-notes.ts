// #140 A fila de notas de devolução no fio: `GET /api/notas-devolucao` e as duas ações.
import { apiGet, apiPost } from "./client";
import type { Cents, QuantityDto } from "./contract";

export type ReturnNoteStatusDto = "pendente" | "emitida" | "cancelada";

export interface ReturnNoteLineDto {
  supplierCode: string;
  description: string;
  quantity: QuantityDto;
  valueCents: Cents | null;
}

export interface ReturnNoteDto {
  id: number;
  status: ReturnNoteStatusDto;
  invoiceAccessKey: string;
  invoiceNumber: string | null;
  supplierId: string | null;
  reason: string;
  lines: ReturnNoteLineDto[];
  valueCents: Cents | null;
  publishedAt: string;
  pendingSeconds: number | null;
  emitted: { number: string; by: string; at: string } | null;
  cancelled: { justification: string; by: string; at: string } | null;
}

const path = (id: number, action: string) => `/api/notas-devolucao/${id}/${action}`;

export const returnNotesApi = {
  list(status: ReturnNoteStatusDto, signal?: AbortSignal): Promise<{ notes: ReturnNoteDto[] }> {
    const query = status === "pendente" ? "" : `?estado=${status}`;
    return apiGet(`/api/notas-devolucao${query}`, { signal });
  },
  emit: (id: number, nfeNumber: string) => apiPost<ReturnNoteDto>(path(id, "emitir"), { nfeNumber }),
  cancel: (id: number, justification: string) => apiPost<ReturnNoteDto>(path(id, "cancelar"), { justification }),
};
