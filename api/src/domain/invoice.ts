import { CHECKS } from './checks/index.js';
import type { NamedCheck } from './checks/check.js';
import { highestPrecedence, type Classification } from './classification.js';
import type { CheckContext } from './context.js';
import type { Divergence } from './divergence.js';
import { InvalidTransitionError } from './errors.js';
import type { Money } from './money.js';
import type { Quantity } from './quantity.js';

export type InvoiceState = 'a_conferir' | 'conferida' | 'com_proposta' | 'decidida'; // ADR-002

export type InvoiceItem = {
  readonly supplierCode: string;
  readonly sku: string | null;
  readonly description: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly total: Money;
};

/** #59: o que uma verificação, a conciliação e a duplicidade leem da nota, sem as transições. */
export type InvoiceView = Pick<
  Invoice,
  | 'accessKey'
  | 'number'
  | 'series'
  | 'supplierId'
  | 'store'
  | 'issuedOn'
  | 'purchaseOrderRef'
  | 'entryChannel'
  | 'items'
  | 'total'
  | 'state'
  | 'divergences'
  | 'classification'
  | 'equals'
>;

export type InvoiceProps = {
  accessKey: string;
  number: string;
  series: string;
  supplierId: string;
  store: string;
  issuedOn: string;
  purchaseOrderRef: string | null;
  entryChannel: string;
  items: readonly InvoiceItem[];
  total: Money;
};

/** A nota fiscal: raiz do agregado da conferência. */
export class Invoice {
  readonly accessKey: string;
  readonly number: string;
  readonly series: string;
  readonly supplierId: string;
  readonly store: string;
  readonly issuedOn: string;
  readonly purchaseOrderRef: string | null;
  readonly entryChannel: string;
  readonly items: readonly InvoiceItem[];
  readonly total: Money;
  private currentState: InvoiceState = 'a_conferir';
  private found: readonly Divergence[] = Object.freeze([]);

  private constructor(props: InvoiceProps) {
    this.accessKey = props.accessKey;
    this.number = props.number;
    this.series = props.series;
    this.supplierId = props.supplierId;
    this.store = props.store;
    this.issuedOn = props.issuedOn;
    this.purchaseOrderRef = props.purchaseOrderRef;
    this.entryChannel = props.entryChannel;
    this.items = Object.freeze(props.items.map((i) => Object.freeze({ ...i })));
    this.total = props.total;
  }

  static receive(props: InvoiceProps): Invoice {
    return new Invoice(props);
  }

  get state(): InvoiceState {
    return this.currentState;
  }

  get divergences(): readonly Divergence[] {
    return this.found;
  }

  /** Regra 6, #59: vale a divergência de maior precedência; sem nenhuma, MATCH. */
  get classification(): Classification {
    return highestPrecedence(this.found.map((d) => d.classification));
  }

  /** Regra 1, #59: a nota é única pela chave de acesso. */
  equals(other: InvoiceView): boolean {
    return this.accessKey === other.accessKey;
  }

  /**
   * Regra 2, #59: roda as verificações na ordem da lista e para logo depois da duplicidade (E6)
   * quando ela acha alguma coisa. Passa a nota a conferida.
   */
  check(ctx: CheckContext, checks: readonly NamedCheck[] = CHECKS): void {
    this.assertState('a_conferir', 'conferir');
    const collected: Divergence[] = [];
    for (const { id, run } of checks) {
      const result = run(this, ctx);
      collected.push(...result);
      if (id === 'E6' && result.length > 0) break;
    }
    this.found = Object.freeze(collected);
    this.currentState = 'conferida';
  }

  markProposed(): void {
    this.assertState('conferida', 'registrar a proposta');
    this.currentState = 'com_proposta';
  }

  markDecided(): void {
    this.assertState('com_proposta', 'decidir');
    this.currentState = 'decidida';
  }

  private assertState(expected: InvoiceState, action: string): void {
    if (this.currentState !== expected) {
      throw new InvalidTransitionError('Invoice', this.currentState, action);
    }
  }
}
