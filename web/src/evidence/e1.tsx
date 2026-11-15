import { GenericEvidence } from "./GenericEvidence";
import { registerEvidence, type EvidenceProps } from "./registry";

/**
 * E1 · Falta física. A história desta exceção troca o corpo do componente; o registro, na última linha, fica.
 * Até lá, delega ao genérico.
 */
function FaltaFisicaEvidence({ divergence }: EvidenceProps) {
  return <GenericEvidence divergence={divergence} />;
}

registerEvidence("E1", FaltaFisicaEvidence);
