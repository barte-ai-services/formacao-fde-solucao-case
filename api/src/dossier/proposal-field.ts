import {
  dossierNotice,
  dossierNoticeFor,
  type DossierField,
  type DossierFieldUnavailable,
  type DossierResult,
} from '../domain/index.js';

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

/** #68: o dossiê que o Worker não conseguiu ler agora (#38/AC-4: a proposta segue sem ele). */
export function dossierReadFailed(): DossierFieldUnavailable {
  return { status: 'unavailable', reason: 'read_failed', notice: dossierNoticeFor('read_failed'), generatedAt: null };
}
