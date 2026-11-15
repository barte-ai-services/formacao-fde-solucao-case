// #140 A fila de notas de devolução no fio: `GET /api/return-notes` e as duas ações.
import { apiGet, apiPost } from "./client";
import type { Cents, QuantityDto } from "./contract";

export type ReturnNoteStatusDto = "pendente" | "emitida" | "cancelada"; // ADR-002

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

const path = (id: number, action: string) => `/api/return-notes/${id}/${action}`;

export const returnNotesApi = {
  list(status: ReturnNoteStatusDto, signal?: AbortSignal): Promise<{ notes: ReturnNoteDto[] }> {
    const query = status === "pendente" ? "" : `?status=${status}`;
    return apiGet(`/api/return-notes${query}`, { signal });
  },
  emit: (id: number, nfeNumber: string) => apiPost<ReturnNoteDto>(path(id, "issue"), { nfeNumber }),
  cancel: (id: number, justification: string) => apiPost<ReturnNoteDto>(path(id, "cancel"), { justification }),
};
