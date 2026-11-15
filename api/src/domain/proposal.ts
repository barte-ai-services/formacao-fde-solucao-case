import type { AmountAtRisk } from './amount-at-risk.js';
import type { ApprovalLevel } from './approval-level.js';
import type { Classification } from './classification.js';
import type { DockAction } from './dock-action.js';
import { DomainError, InvalidTransitionError } from './errors.js';

export type ProposalState = 'registrada' | 'aguardando_aprovacao' | 'aprovada' | 'alterada';

export type ProposalProps = {
  classification: Classification;
  dockAction: DockAction;
  level: ApprovalLevel;
  amountAtRisk: AmountAtRisk;
  justification: string;
};

/** A proposta do agente para a nota. Quem aprova é a regra (match) ou uma pessoa. */
export class Proposal {
  readonly classification: Classification;
  readonly dockAction: DockAction;
  readonly level: ApprovalLevel;
  readonly amountAtRisk: AmountAtRisk;
  private currentJustification: string;
  private currentState: ProposalState = 'registrada';

  private constructor(props: ProposalProps) {
    this.classification = props.classification;
    this.dockAction = props.dockAction;
    this.level = props.level;
    this.amountAtRisk = props.amountAtRisk;
    this.currentJustification = props.justification;
  }

  static register(props: ProposalProps): Proposal {
    return new Proposal(props);
  }

  get state(): ProposalState {
    return this.currentState;
  }

  get justification(): string {
    return this.currentJustification;
  }

  /** Acima do nível regra, a proposta espera uma pessoa. */
  awaitApproval(): void {
    this.assertState('registrada', 'aguardar aprovação');
    if (this.level === 'regra') {
      throw new DomainError('Proposal: no nível regra a aprovação é pela regra, sem pessoa');
    }
    this.currentState = 'aguardando_aprovacao';
  }

  /** Regra 8: o match é aprovado pela regra, sem pessoa. Só no nível regra. */
  approveByRule(): void {
    this.assertState('registrada', 'aprovar pela regra');
    if (this.level !== 'regra') {
      throw new DomainError(`Proposal: nível ${this.level} exige uma pessoa para aprovar`);
    }
    this.currentState = 'aprovada';
  }

  /** Regra 8: aprova uma vez só. */
  approve(): void {
    this.assertState('aguardando_aprovacao', 'aprovar');
    this.currentState = 'aprovada';
  }

  /** Regra 8: alterar exige justificativa. */
  alter(justification: string): void {
    this.assertState('aguardando_aprovacao', 'alterar');
    if (justification.trim() === '') {
      throw new DomainError('Proposal: alterar exige justificativa');
    }
    this.currentJustification = justification;
    this.currentState = 'alterada';
  }

  private assertState(expected: ProposalState, action: string): void {
    if (this.currentState !== expected) {
      throw new InvalidTransitionError('Proposal', this.currentState, action);
    }
  }
}
