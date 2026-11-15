// O assinante do evento "proposta aprovada" para a nota de loja: publica a ação no app da loja (#135, AC-1).
import type { Published, StoreActionMessage, StoreActionOutbox } from '../connectors/ports.js';
import { DomainError } from '../domain/index.js';
import type { ProposalApproved } from './publish-approved-dock-action.js';
import { receivingPlace } from './receiving-place.js';

/**
 * #135 AC-1 Publica `{ invoiceAccessKey, store, action }` na caixa de saída do app da loja. Só nota de
 * loja (`LJ-*`): destino de CD lança DomainError, porque a ação dele vai para o WMS. Proposta sem
 * decisão também lança (#43 AC-3). Idempotente pela caixa de saída, como a do WMS.
 */
export async function publishApprovedStoreAction(
  event: ProposalApproved,
  store: string,
  outbox: StoreActionOutbox,
): Promise<Published<StoreActionMessage>> {
  const { invoiceAccessKey, proposal } = event;
  if (invoiceAccessKey.trim() === '') throw new DomainError('publishApprovedStoreAction: evento sem a chave da nota');
  if (receivingPlace(store) !== 'app_loja') {
    throw new DomainError(`publishApprovedStoreAction: ${store} recebe na doca do CD, não no app da loja`);
  }
  if (proposal.state !== 'aprovada' && proposal.state !== 'alterada') {
    throw new DomainError(`publishApprovedStoreAction: proposta em "${proposal.state}" não tem decisão`);
  }
  return outbox.publish({ invoiceAccessKey, store, action: proposal.dockAction });
}
