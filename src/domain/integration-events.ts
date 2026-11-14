import { randomUUID } from 'node:crypto';
import { FailureCode } from './errors';
import { MoneyProps } from './money';
import { WagerTransaction } from './wager-transaction';
import { Wallet } from './wallet';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Contexto de rastreamento propagado da requisição/mensagem para os eventos. */
export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Envelope dos eventos de integração. `eventType` e `version` ficam no TIPO
 * (cada subclasse), não em strings soltas no código que publica.
 * `eventId` é estável: consumidores usam-no para descartar duplicatas.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze(props.data);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

function baseProps<T>(aggregateId: string, ctx: EventContext, data: T): IntegrationEventProps<T> {
  return {
    eventId: randomUUID(),
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    data,
  };
}

/** Campos comuns a todos os eventos de transação. Dinheiro sempre como MoneyProps (string). */
interface WagerTransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function transactionData(tx: WagerTransaction): WagerTransactionData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
  };
}

// ------------------------------------------------------------------ eventos

export interface WagerTransactionProcessedData extends WagerTransactionData {
  referenceTransactionId?: string;
  balance: MoneyProps;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      baseProps(tx.walletId, ctx, {
        ...transactionData(tx),
        referenceTransactionId: tx.referenceTransactionId,
        balance: tx.balanceAfter!.toJSON(),
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(
      baseProps(tx.walletId, ctx, { ...transactionData(tx), failureCode: tx.failureCode! }),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionData {
  attempt: number;
  nextCheckAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      baseProps(tx.walletId, ctx, {
        ...transactionData(tx),
        attempt: tx.referenceAttempts,
        nextCheckAt: tx.nextReferenceCheckAt!.toISOString(),
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda (ou seja, sempre junto de um lançamento de ledger). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      baseProps(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}
