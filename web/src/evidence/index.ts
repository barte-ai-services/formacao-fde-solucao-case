// Um arquivo por código. Cada import registra o componente daquele código; nenhuma história
// precisa mexer nesta lista.
import "./e1";
import "./e2";
import "./e3";
import "./e4";
import "./e5";
import "./e6";
import "./e7";
import "./e8";
import "./nao-catalogada";

export { EvidenceView } from "./EvidenceView";
export { GenericEvidence } from "./GenericEvidence";
export { registerEvidence, evidenceComponentFor, type EvidenceComponent, type EvidenceProps } from "./registry";
