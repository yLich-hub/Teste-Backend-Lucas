/**
 * Erros da camada de aplicação. Cada um tem um código estável e uma
 * "categoria" que diz ao chamador (HTTP ou consumidor SQS) o que fazer:
 *
 *  - validation : payload inválido            -> HTTP 400 | SQS: DLQ (reenviar igual não resolve)
 *  - not_found  : recurso inexistente         -> HTTP 404 | SQS: DLQ
 *  - conflict   : conflito (idempotência etc.) -> HTTP 409 | SQS: DLQ
 *  - transient  : infraestrutura indisponível  -> HTTP 503 | SQS: retry com backoff
 */
export type ErrorCategory = 'validation' | 'not_found' | 'conflict' | 'transient';

export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly category: ErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class IdempotencyConflictError extends AppError {
  constructor() {
    super(
      'IDEMPOTENCY_CONFLICT',
      'conflict',
      'idempotency key (or external transaction id) already used with a different payload',
    );
  }
}

export class WalletNotFoundError extends AppError {
  constructor(walletId: string) {
    super('WALLET_NOT_FOUND', 'not_found', `wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends AppError {
  constructor() {
    super('WALLET_ALREADY_EXISTS', 'conflict', 'a wallet already exists for this playerId + currency');
  }
}

export class TransactionNotFoundError extends AppError {
  constructor() {
    super('TRANSACTION_NOT_FOUND', 'not_found', 'transaction not found');
  }
}

/** Mesma messageId do SQS chegou com outro conteúdo: bug do produtor. */
export class InboxPayloadMismatchError extends AppError {
  constructor(messageId: string) {
    super('INBOX_PAYLOAD_MISMATCH', 'conflict', `message ${messageId} redelivered with a different payload`);
  }
}

/** Falha temporária (banco fora, lock timeout, deadlock): pode tentar de novo. */
export class TransientError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('SERVICE_UNAVAILABLE', 'transient', message);
    this.cause = cause;
  }
}
