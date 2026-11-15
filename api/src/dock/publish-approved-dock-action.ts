// O assinante do evento "proposta aprovada": publica a ação na doca para o WMS (#72, #43 AC-1).
import type { DockActionMessage, DockActionOutbox, Published } from '../connectors/ports.js';
import { DomainError, type Proposal, type ProposalState } from '../domain/index.js';

/** #72 O evento que a aprovação emite quando a proposta de uma nota foi decidida. */
export type ProposalApproved = {
  readonly type: 'proposta_aprovada';
  readonly invoiceAccessKey: string;
  readonly proposal: Proposal;
};

// #72 Regra 8: só uma decisão publica. Aprovada pela regra ou por uma pessoa, ou alterada com justificativa.
const DECIDED: readonly ProposalState[] = ['aprovada', 'alterada'];

/**
 * #72 Assinante do evento "proposta aprovada". A aprovação da #63 chama esta função depois de gravar a
 * decisão. Publica `{ invoiceAccessKey, action }` na caixa de saída do WMS; a caixa de saída é
 * idempotente pela nota e pelo payload, então o mesmo evento entregue duas vezes grava uma linha só.
 * #43 AC-3: proposta sem decisão (registrada ou aguardando aprovação) lança DomainError e não publica.
 */
export async function publishApprovedDockAction(
  event: ProposalApproved,
  outbox: DockActionOutbox,
): Promise<Published<DockActionMessage>> {
  const { invoiceAccessKey, proposal } = event;
  if (invoiceAccessKey.trim() === '') {
    throw new DomainError('publishApprovedDockAction: evento sem a chave da nota');
  }
  if (!DECIDED.includes(proposal.state)) {
    throw new DomainError(
      `publishApprovedDockAction: proposta em "${proposal.state}" não tem decisão; a doca segue aguardando aprovação`,
    );
  }
  return outbox.publish({ invoiceAccessKey, action: proposal.dockAction });
}
