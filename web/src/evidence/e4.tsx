import { GenericEvidence } from "./GenericEvidence";
import { registerEvidence, type EvidenceProps } from "./registry";

/**
 * E4 · Unidade de medida. A história desta exceção troca o corpo do componente; o registro, na última linha, fica.
 * Até lá, delega ao genérico.
 */
function UnidadeDeMedidaEvidence({ divergence }: EvidenceProps) {
  return <GenericEvidence divergence={divergence} />;
}

registerEvidence("E4", UnidadeDeMedidaEvidence);
