import { DomainError } from './errors.js';
import type { Quantity } from './quantity.js';

export type PartialLine = {
  readonly sku: string;
  readonly quantity: Quantity;
  readonly disposition: 'segurar' | 'devolver';
};

/** O que a doca faz com a carga. */
export type DockAction =
  | { readonly kind: 'receber' }
  | { readonly kind: 'receber_parcial'; readonly lines: readonly PartialLine[] }
  | { readonly kind: 'recusar' };

export const DockAction = {
  receive(): DockAction {
    return Object.freeze({ kind: 'receber' });
  },
  /** Receber parcial sem itens a segurar ou devolver não existe. */
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
