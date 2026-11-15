/** Erro de regra do domínio: uma invariante foi violada ou uma transição não existe. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Transição de estado que o modelo não permite. */
export class InvalidTransitionError extends DomainError {
  constructor(entity: string, from: string, action: string) {
    super(`${entity}: não é possível ${action} a partir de "${from}"`);
    this.name = 'InvalidTransitionError';
  }
}
