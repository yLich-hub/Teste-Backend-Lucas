/**
 * Códigos de falha estáveis (legíveis por máquina) gravados em transações
 * REJECTED/FAILED. O provedor usa o código para decidir se reenvia, corrige
 * ou desiste. Ver ARCHITECTURE.md > "Taxonomia de falhas".
 */
export enum FailureCode {
  // ---- regra de negócio (status REJECTED) — reenviar o mesmo payload NÃO adianta
  InsufficientFunds = 'INSUFFICIENT_FUNDS', // BET sem saldo
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS', // ROLLBACK de crédito deixaria saldo negativo
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerMismatch = 'PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND', // esgotou as tentativas de achar a referência
  ReferenceMismatch = 'REFERENCE_MISMATCH', // referência de outro player/wallet/moeda/rodada
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND', // ex.: REFUND apontando para WIN
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED', // referência REJECTED/FAILED
  AmountMismatch = 'AMOUNT_MISMATCH', // reversão com valor diferente da referência
  AlreadyReversed = 'ALREADY_REVERSED',

  // ---- erro permanente de infraestrutura (status FAILED)
  ProcessingError = 'PROCESSING_ERROR',
}

/** Erro base do domínio: violação de regra ou de invariante. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada inválida (formato, escala, campos obrigatórios). */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super(FailureCode.CurrencyMismatch, `currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super(FailureCode.InsufficientFunds, 'insufficient funds');
  }
}

/** Tentativa de transicionar uma transação já terminal: erro de programação. */
export class InvalidTransactionStateError extends DomainError {
  constructor(from: string, to: string) {
    super('INVALID_TRANSACTION_STATE', `invalid transition ${from} -> ${to}`);
  }
}

/** Lançamento de ledger cuja aritmética não fecha. */
export class UnbalancedLedgerEntryError extends DomainError {
  constructor() {
    super('UNBALANCED_LEDGER_ENTRY', 'balanceBefore +/- money !== balanceAfter');
  }
}
