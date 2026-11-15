import { DomainError } from './errors.js';
import type { Quantity } from './quantity.js';

export type PartialLine = {
  readonly sku: string;
  readonly quantity: Quantity;
  readonly disposition: 'segurar' | 'devolver'; // ADR-002
};

/** O que a doca faz com a carga. */
export type DockAction =
  | { readonly kind: 'receber' } // ADR-002
  | { readonly kind: 'receber_parcial'; readonly lines: readonly PartialLine[] } // ADR-002
  | { readonly kind: 'recusar' }; // ADR-002

export const DockAction = {
  receive(): DockAction {
    return Object.freeze({ kind: 'receber' });
  },
  /** #59: receber parcial sem itens a segurar ou devolver não existe. */
  partial(lines: readonly PartialLine[]): DockAction {
    if (lines.length === 0) {
      throw new DomainError('DockAction: receber parcial exige ao menos uma linha');
    }
    return Object.freeze({ kind: 'receber_parcial', lines: Object.freeze([...lines]) });
  },
  refuse(): DockAction {
    return Object.freeze({ kind: 'recusar' });
  },
};
