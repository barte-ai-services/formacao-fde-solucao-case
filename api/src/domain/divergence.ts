import type { Classification } from './classification.js';
import { DomainError } from './errors.js';
import type { Evidence } from './evidence.js';

export type DivergenceProps = {
  classification: Exclude<Classification, 'MATCH'>;
  skus: readonly string[];
  evidence: readonly Evidence[];
};

/** Uma exceção encontrada na conferência. Imutável. */
export class Divergence {
  readonly classification: Exclude<Classification, 'MATCH'>;
  readonly skus: readonly string[];
  readonly evidence: readonly Evidence[];

  private constructor(props: DivergenceProps) {
    this.classification = props.classification;
    this.skus = Object.freeze([...props.skus]);
    this.evidence = Object.freeze(props.evidence.map((e) => Object.freeze({ ...e })));
    Object.freeze(this);
  }

  /** Regra 6, #59: toda divergência cita ao menos uma evidência. */
  static of(props: DivergenceProps): Divergence {
    if (props.evidence.length === 0) {
      throw new DomainError(`Divergence ${props.classification}: toda divergência cita uma evidência`);
    }
    return new Divergence(props);
  }
}
