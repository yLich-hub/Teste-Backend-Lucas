import { FailureCode, InvalidTransactionStateError, ValidationError } from './errors';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada (só existe em memória)
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal)
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Backoff da espera por referência: 1s, 2s, 4s ... (máx. 5 min), até 10 tentativas (~17 min). */
export interface ReferenceRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
export const DEFAULT_REFERENCE_RETRY: ReferenceRetryPolicy = {
  maxAttempts: 10,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  balanceAfter?: Money;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date;
}

/**
 * Uma operação do provedor (BET, WIN, ...).
 *
 * Transições válidas:
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
 *   PROCESSED, REJECTED, FAILED -> (nenhuma; são terminais)
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    /** saldo da wallet observado quando a transação foi decidida (usado no replay) */
    private _balanceAfter?: Money,
    private _referenceAttempts = 0,
    private _nextReferenceCheckAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const tx = new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
    if (tx.requiresReference() && !tx.referenceExternalTransactionId) {
      throw new ValidationError(`${tx.kind} requires referenceExternalTransactionId`);
    }
    if (tx.referenceExternalTransactionId && !tx.acceptsReference()) {
      throw new ValidationError(`${tx.kind} cannot reference another transaction`);
    }
    if (tx.referenceExternalTransactionId === tx.externalTransactionId) {
      throw new ValidationError('a transaction cannot reference itself');
    }
    if (tx.affectsBalance() && !tx.money.isPositive()) {
      throw new ValidationError(`${tx.kind} amount must be greater than zero`);
    }
    return tx;
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.balanceAfter,
      s.referenceAttempts,
      s.nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---------------------------------------------------------------- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._balanceAfter = balanceAfter;
    this._nextReferenceCheckAt = undefined;
  }

  /**
   * Primeira vez: entra em PENDING_REFERENCE. Nas seguintes: conta mais uma
   * tentativa. Sempre agenda a próxima checagem com backoff exponencial.
   */
  markPendingReference(at: Date, balance: Money, policy = DEFAULT_REFERENCE_RETRY): void {
    const firstTime = this._status === WagerTransactionStatus.Pending;
    this.transitionTo(WagerTransactionStatus.PendingReference);
    if (!firstTime) this._referenceAttempts += 1;
    const delay = Math.min(policy.baseDelayMs * 2 ** this._referenceAttempts, policy.maxDelayMs);
    this._nextReferenceCheckAt = new Date(at.getTime() + delay);
    this._balanceAfter = balance;
  }

  referenceRetriesExhausted(policy = DEFAULT_REFERENCE_RETRY): boolean {
    return this._referenceAttempts >= policy.maxAttempts;
  }

  reject(code: FailureCode, at: Date, balance: Money): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._processedAt = at;
    this._balanceAfter = balance;
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
  }

  // ---------------------------------------------------------- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** LOSS só registra o resultado da rodada; não move saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** WIN/LOSS podem (opcionalmente) apontar para a BET da rodada. */
  acceptsReference(): boolean {
    return this.requiresReference() || this.kind === WagerTransactionKind.Win || this.kind === WagerTransactionKind.Loss;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  /** Kinds que esta transação pode referenciar (regra 3 do README). */
  allowedReferenceKinds(): WagerTransactionKind[] {
    switch (this.kind) {
      case WagerTransactionKind.Refund:
        return [WagerTransactionKind.Bet];
      case WagerTransactionKind.Rollback:
        return [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Loss:
        return [WagerTransactionKind.Bet];
      default:
        return [];
    }
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direção do lançamento. ROLLBACK é o inverso da transação referenciada. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        const original = reference?.ledgerDirectionFor();
        if (!original) throw new ValidationError('ROLLBACK needs a balance-affecting reference');
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, next);
    }
    this._status = next;
  }
}
