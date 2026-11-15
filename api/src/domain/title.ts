import { DomainError, InvalidTransitionError } from './errors.js';
import type { Money } from './money.js';

export type TitleState = 'lancado' | 'liberado' | 'reduzido' | 'bloqueado' | 'na_lista_do_dia'; // ADR-002

export type TitleProps = {
  invoiceAccessKey: string;
  amount: Money;
  dueOn: string;
};

/** O título a pagar da nota, no Contas a pagar. */
export class Title {
  readonly invoiceAccessKey: string;
  readonly dueOn: string;
  private currentAmount: Money;
  private currentState: TitleState = 'lancado';

  private constructor(props: TitleProps) {
    this.invoiceAccessKey = props.invoiceAccessKey;
    this.currentAmount = props.amount;
    this.dueOn = props.dueOn;
  }

  static post(props: TitleProps): Title {
    return new Title(props);
  }

  get amount(): Money {
    return this.currentAmount;
  }

  get state(): TitleState {
    return this.currentState;
  }

  release(): void {
    this.assertState(['lancado'], 'liberar');
    this.currentState = 'liberado';
  }

  /** #59: reduz para um valor entre zero e o atual, ambos exclusivos. */
  reduce(to: Money): void {
    this.assertState(['lancado'], 'reduzir');
    if (to.compare(this.currentAmount) >= 0 || to.isZero() || to.isNegative()) {
      throw new DomainError(
        `Title: o valor reduzido deve ficar entre R$ 0,00 e ${this.currentAmount.toString()}, exclusivos`,
      );
    }
    this.currentAmount = to;
    this.currentState = 'reduzido';
  }

  block(): void {
    this.assertState(['lancado'], 'bloquear');
    this.currentState = 'bloqueado';
  }

  scheduleToday(): void {
    this.assertState(['liberado', 'reduzido'], 'pôr na lista do dia');
    this.currentState = 'na_lista_do_dia';
  }

  private assertState(allowed: readonly TitleState[], action: string): void {
    if (!allowed.includes(this.currentState)) {
      throw new InvalidTransitionError('Title', this.currentState, action);
    }
  }
}
