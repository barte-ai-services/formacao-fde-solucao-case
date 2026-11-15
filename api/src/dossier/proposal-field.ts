import type { Classification } from '../domain/classification.js';
import { EXCEPTION_CATALOG } from '../domain/exception-catalog.js';
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
  if (result?.status === 'ready') {
    return { ...result, divergences: result.divergences.map((d) => ({ ...d, ...nameOf(d.classification) })) };
  }
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

/**
 * #130 O dossiê pedido na gaveta e ainda em geração: a gaveta mostra Gerando e lê a proposta de novo até virar
 * `ready` ou `unavailable`.
 */
export type DossierFieldGenerating = {
  readonly status: 'generating';
  /** #130 #38 `event`: o Claude começou quando a nota chegou; `on_demand`: a pessoa pediu na gaveta. */
  readonly trigger: 'event' | 'on_demand';
  readonly requestedBy: string;
  readonly requestedAt: string;
};

/** #130 O campo `dossier` da proposta, com o estado de geração sob demanda. */
export type ProposalDossierField = DossierField | DossierFieldGenerating;

/** #130 O pedido da gaveta em andamento. */
export function dossierGenerating(
  requestedBy: string,
  requestedAt: string,
  trigger: DossierFieldGenerating['trigger'] = 'on_demand',
): DossierFieldGenerating {
  return { status: 'generating', trigger, requestedBy, requestedAt };
}

/** #128: o nome do glossário vem do catálogo da API, para a tela não traduzir código. */
function nameOf(classification: string): { exceptionName?: string } {
  return Object.hasOwn(EXCEPTION_CATALOG, classification)
    ? { exceptionName: EXCEPTION_CATALOG[classification as Classification].name }
    : {};
}
