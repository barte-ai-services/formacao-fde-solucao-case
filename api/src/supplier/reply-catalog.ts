import { buildSupplierRequestFacts, withFollowUpDueDate, type FactCatalog } from '../domain/index.js';
import type { ReplyRequest } from './reply-ports.js';

// #34: o que a leitura e a cobrança dividem: o catálogo de fatos do pedido (o mesmo da #2) e o dia de hoje.

/** #34/AC-3: o catálogo do pedido, refeito da nota guardada, do número da nota de origem e do prazo gravado. */
export const catalogOf = (request: ReplyRequest): FactCatalog =>
  buildSupplierRequestFacts(request.note, { number: request.invoiceNumber }, request.dueOn);

/**
 * #58/AC-3: o catálogo da cobrança: o do pedido mais o novo prazo gravado com o rascunho (`cobranca.prazo`). Sem o novo prazo (o rascunho
 * do Claude, de antes da #58) é o do pedido: o marcador do novo prazo, nesse caso, é recusado, e nenhum número sai sem fato.
 */
export const followUpCatalogOf = (request: ReplyRequest): FactCatalog => {
  const base = catalogOf(request);
  return request.followUp.dueOn === null ? base : withFollowUpDueDate(base, request.followUp.dueOn);
};

const TIME_ZONE = 'America/Sao_Paulo';

// #34: igual a todayIso de #11 (draft.ts); unificar quando #38 entrar (ADR-005: o domínio não lê a hora).
export const todayIso = (now: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now);
