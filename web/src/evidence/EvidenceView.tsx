import { Component, type ReactNode } from "react";
import type { DivergenceDto } from "../api/contract";
import { GenericEvidence } from "./GenericEvidence";
import { evidenceComponentFor } from "./registry";

/** Se o componente registrado quebrar, a tela não quebra: mostra o genérico no lugar. */
class FallbackToGeneric extends Component<{ divergence: DivergenceDto; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: { divergence: DivergenceDto }) {
    if (this.state.failed && previous.divergence !== this.props.divergence) this.setState({ failed: false });
  }

  render() {
    return this.state.failed ? <GenericEvidence divergence={this.props.divergence} /> : this.props.children;
  }
}

/** A evidência de uma divergência: o componente registrado para o código, ou o genérico. */
export function EvidenceView({ divergence }: { divergence: DivergenceDto }) {
  const Registered = evidenceComponentFor(String(divergence.classification));
  if (!Registered) return <GenericEvidence divergence={divergence} />;
  return (
    <FallbackToGeneric divergence={divergence}>
      <Registered divergence={divergence} />
    </FallbackToGeneric>
  );
}
