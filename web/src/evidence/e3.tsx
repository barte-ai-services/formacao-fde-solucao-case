import { GenericEvidence } from "./GenericEvidence";
import { registerEvidence, type EvidenceProps } from "./registry";

/**
 * E3 · Quantidade menor. A história desta exceção troca o corpo do componente; o registro, na última linha, fica.
 * Até lá, delega ao genérico.
 */
function QuantidadeMenorEvidence({ divergence }: EvidenceProps) {
  return <GenericEvidence divergence={divergence} />;
}

registerEvidence("E3", QuantidadeMenorEvidence);
