import { GenericEvidence } from "./GenericEvidence";
import { registerEvidence, type EvidenceProps } from "./registry";

/**
 * E8 · Item sem cadastro. A história desta exceção troca o corpo do componente; o registro, na última linha, fica.
 * Até lá, delega ao genérico.
 */
function ItemSemCadastroEvidence({ divergence }: EvidenceProps) {
  return <GenericEvidence divergence={divergence} />;
}

registerEvidence("E8", ItemSemCadastroEvidence);
