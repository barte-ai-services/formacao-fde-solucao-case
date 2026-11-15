import { DomainError } from './errors.js';
import { Money } from './money.js';

/** Quanto se pagaria a mais se a nota fosse paga como veio. Regra 6: entre zero e o valor da nota. */
export class AmountAtRisk {
  private constructor(
    readonly amount: Money,
    readonly invoiceTotal: Money,
  ) {
    Object.freeze(this);
  }

  static of(amount: Money, invoiceTotal: Money): AmountAtRisk {
    if (amount.isNegative() || amount.compare(invoiceTotal) > 0) {
      throw new DomainError(
        `AmountAtRisk: ${amount.toString()} fora do intervalo [R$ 0,00, ${invoiceTotal.toString()}]`,
      );
    }
    return new AmountAtRisk(amount, invoiceTotal);
  }

  /** Regra 3, #59: na duplicidade, o valor em risco é o valor da nota. */
  static full(invoiceTotal: Money): AmountAtRisk {
    return AmountAtRisk.of(invoiceTotal, invoiceTotal);
  }
}
