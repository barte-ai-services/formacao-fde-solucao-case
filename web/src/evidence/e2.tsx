import { GenericEvidence } from "./GenericEvidence";
import { registerEvidence, type EvidenceProps } from "./registry";

/**
 * E2 · Item trocado. A história desta exceção troca o corpo do componente; o registro, na última linha, fica.
 * Até lá, delega ao genérico.
 */
function ItemTrocadoEvidence({ divergence }: EvidenceProps) {
  return <GenericEvidence divergence={divergence} />;
}

registerEvidence("E2", ItemTrocadoEvidence);
