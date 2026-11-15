import { dossierNotice, type DossierField, type DossierResult } from '../domain/index.js';

// #68: o campo `dossier` que a API da proposta expõe em `GET /api/propostas/:chave`.

export type { DossierField, DossierFieldUnavailable } from '../domain/index.js';

/**
 * #68: pronto vai como está. Indisponível, e também sem dossiê (`null` → `pending`), leva o motivo e
 * o aviso de `dossierNotice`. Sempre serializável em JSON.
 */
export function dossierField(result: DossierResult | null): DossierField {
  if (result?.status === 'ready') return result;
  return {
    status: 'unavailable',
    reason: result?.reason ?? 'pending',
    notice: dossierNotice(result) ?? '',
    generatedAt: result?.generatedAt ?? null,
  };
}
