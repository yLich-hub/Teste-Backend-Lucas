import { randomUUID } from 'node:crypto';
import { FailureCode } from '../domain/errors';
import { InboxMessage } from '../domain/inbox-message';
import {
  EventContext,
  IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/integration-events';
import { Money, MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import {
  DEFAULT_REFERENCE_RETRY,
  ReferenceRetryPolicy,
  WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import { decideWager } from '../domain/wager-rules';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { Database, isLockConflict, isUniqueViolation, Tx } from '../infrastructure/database/database';
import { JsonLogger } from '../infrastructure/observability/logger';
import { Metrics } from '../infrastructure/observability/metrics';
import { IdempotencyConflictError, WalletNotFoundError } from './errors';
import { WagerCommand } from './wager-command';

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

/** `duplicateMessage` = a mensagem SQS já tinha sido processada (inbox). */
export type ProcessOutcome = { duplicateMessage: true } | ({ duplicateMessage: false } & WagerResult);

export interface ProcessContext {
  correlationId: string;
  source: 'http' | 'sqs';
  /** presente quando a entrada veio da fila */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

/**
 * O caso de uso central. É o MESMO para HTTP e SQS.
 *
 * Tudo acontece em UMA transação SQL:
 *   1. (SQS) registra a mensagem no inbox — se já existia, é duplicata: para aqui;
 *   2. trava a linha da wallet (SELECT ... FOR UPDATE);
 *   3. procura a idempotency key: mesma key + mesmo hash = replay; hash diferente = conflito;
 *   4. aplica as regras (decideWager) e move o saldo, se for o caso;
 *   5. grava transação, wallet, lançamento do ledger e eventos na outbox;
 *   6. COMMIT. Só depois disso alguém publica os eventos (worker da outbox).
 */
export class ProcessWagerService {
  constructor(
    private readonly db: Database,
    private readonly metrics: Metrics,
    private readonly logger: JsonLogger,
    private readonly retryPolicy: ReferenceRetryPolicy = DEFAULT_REFERENCE_RETRY,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(cmd: WagerCommand, ctx: ProcessContext): Promise<ProcessOutcome> {
    const stopTimer = this.metrics.processingLatency.startTimer({ source: ctx.source });
    try {
      const outcome = await this.db.transaction((tx) => this.executeInTransaction(tx, cmd, ctx));
      if (!outcome.duplicateMessage) this.logDecision(outcome, cmd, ctx);
      return outcome;
    } catch (err) {
      throw this.translateError(err);
    } finally {
      stopTimer();
    }
  }

  /**
   * Chamado pelo worker de referências pendentes. Re-tenta resolver a
   * referência de uma transação PENDING_REFERENCE.
   */
  async retryPendingReference(transactionId: string): Promise<WagerResult | undefined> {
    try {
      return await this.db.transaction(async (tx) => {
        const now = this.clock();
        const peek = await tx.transactions.findById(transactionId);
        if (!peek || peek.status !== WagerTransactionStatus.PendingReference) return undefined;

        // Mesmo protocolo do fluxo principal: primeiro a wallet, depois relê a transação.
        const wallet = await this.lockWallet(tx, peek.walletId);
        const txn = await tx.transactions.findById(transactionId);
        if (!wallet || !txn || txn.status !== WagerTransactionStatus.PendingReference) return undefined;
        if (txn.nextReferenceCheckAt && txn.nextReferenceCheckAt > now) return undefined; // outra instância já tentou

        this.metrics.referenceRetries.inc();
        const ctx: EventContext = { correlationId: txn.idempotencyKey, causationId: txn.id, occurredAt: now };
        await this.decideAndPersist(tx, wallet, txn, ctx, false);
        if (txn.isTerminal()) this.countStatus(txn);
        return toResult(txn, false);
      });
    } catch (err) {
      throw this.translateError(err);
    }
  }

  /** Erro inesperado e permanente ao reprocessar: marca FAILED (terminal, auditável). */
  async failPending(transactionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const peek = await tx.transactions.findById(transactionId);
      if (!peek || peek.status !== WagerTransactionStatus.PendingReference) return;
      await tx.wallets.lockById(peek.walletId);
      const txn = await tx.transactions.findById(transactionId);
      if (!txn || txn.status !== WagerTransactionStatus.PendingReference) return;
      txn.fail(FailureCode.ProcessingError, this.clock());
      await tx.transactions.update(txn);
      this.countStatus(txn);
    });
  }

  // ------------------------------------------------------------------ interno

  private async executeInTransaction(tx: Tx, cmd: WagerCommand, ctx: ProcessContext): Promise<ProcessOutcome> {
    const now = this.clock();

    // 1. Inbox: deduplicação persistente da mensagem SQS.
    if (ctx.inbox) {
      const inbox = InboxMessage.receive({ ...ctx.inbox, receivedAt: now });
      inbox.markProcessed(now); // processada nesta mesma transação
      if (!(await tx.inbox.tryInsert(inbox))) {
        this.metrics.duplicates.inc({ source: 'inbox' });
        return { duplicateMessage: true };
      }
    }

    // 2. Lock da wallet: serializa tudo que mexe nesta wallet, em qualquer instância.
    const wallet = await this.lockWallet(tx, cmd.walletId);
    if (!wallet) throw new WalletNotFoundError(cmd.walletId);

    // 3. Idempotência (já sob o lock: não há corrida entre "procurar" e "inserir").
    const existing = await tx.transactions.findExisting(
      cmd.providerId,
      cmd.idempotencyKey,
      cmd.externalTransactionId,
    );
    if (existing) {
      if (existing.idempotencyKey !== cmd.idempotencyKey || !existing.matchesPayload(cmd.payloadHash)) {
        throw new IdempotencyConflictError();
      }
      this.metrics.duplicates.inc({ source: ctx.source });
      return { duplicateMessage: false, ...toResult(existing, true) };
    }

    // 4 e 5. Nova transação: decide, aplica e grava tudo.
    const txn = WagerTransaction.create({
      id: randomUUID(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: cmd.payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: cmd.money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: now,
    });
    const eventCtx: EventContext = {
      correlationId: ctx.correlationId,
      causationId: ctx.inbox?.messageId ?? cmd.idempotencyKey,
      occurredAt: now,
    };
    await this.decideAndPersist(tx, wallet, txn, eventCtx, true);
    return { duplicateMessage: false, ...toResult(txn, false) };
  }

  /** Aplica as regras, muda o estado em memória e grava tudo na transação aberta. */
  private async decideAndPersist(
    tx: Tx,
    wallet: Wallet,
    txn: WagerTransaction,
    ctx: EventContext,
    isNew: boolean,
  ): Promise<void> {
    const now = ctx.occurredAt;
    const loadedVersion = wallet.version;

    let reference: WagerTransaction | undefined;
    let referenceAlreadyReversed = false;
    if (txn.referenceExternalTransactionId) {
      reference = await tx.transactions.findByExternalId(txn.providerId, txn.referenceExternalTransactionId);
      if (reference && txn.isReversal()) {
        referenceAlreadyReversed = await tx.transactions.hasProcessedReversal(reference.id);
      }
    }

    const decision = decideWager({ wallet, transaction: txn, reference, referenceAlreadyReversed });

    let entry: WalletLedgerEntry | undefined;
    switch (decision.type) {
      case 'apply':
        entry = wallet.move(decision.direction, txn.money, txn.id, now);
        txn.markProcessed(reference?.id, now, wallet.balance);
        break;
      case 'record':
        txn.markProcessed(reference?.id, now, wallet.balance);
        break;
      case 'reject':
        txn.reject(decision.code, now, wallet.balance);
        break;
      case 'wait-reference':
        txn.markPendingReference(now, wallet.balance, this.retryPolicy);
        if (txn.referenceRetriesExhausted(this.retryPolicy)) {
          txn.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
        }
        break;
    }

    // Persistência — ordem respeita as FKs. A checagem "saldo == ledger" roda no COMMIT.
    if (isNew) await tx.transactions.insert(txn);
    else await tx.transactions.update(txn);

    const events: IntegrationEvent<unknown>[] = [];
    if (entry) {
      await tx.wallets.update(wallet, loadedVersion);
      await tx.ledger.insert(entry);
      events.push(WalletBalanceChanged.from(wallet, entry, ctx));
    }
    if (txn.status === WagerTransactionStatus.Processed) events.push(WagerTransactionProcessed.from(txn, ctx));
    if (txn.status === WagerTransactionStatus.Rejected) events.push(WagerTransactionRejected.from(txn, ctx));
    if (txn.status === WagerTransactionStatus.PendingReference && isNew) {
      events.push(WagerTransactionPendingReference.from(txn, ctx));
    }
    for (const event of events) await tx.outbox.insert(OutboxMessage.enqueue(event));
  }

  private async lockWallet(tx: Tx, walletId: string): Promise<Wallet | undefined> {
    const stop = this.metrics.lockWait.startTimer();
    try {
      return await tx.wallets.lockById(walletId);
    } finally {
      stop();
    }
  }

  private translateError(err: unknown): unknown {
    // Corrida entre wallets DIFERENTES usando a mesma idempotency key / id externo:
    // o índice único do banco barra a segunda. É conflito (o payload difere no walletId).
    if (isUniqueViolation(err, 'wager_tx_idempotency_uq') || isUniqueViolation(err, 'wager_tx_external_id_uq')) {
      err = new IdempotencyConflictError();
    }
    if (err instanceof IdempotencyConflictError) this.metrics.idempotencyConflicts.inc();
    if (isLockConflict(err)) this.metrics.lockConflicts.inc();
    return err;
  }

  private logDecision(result: WagerResult, cmd: WagerCommand, ctx: ProcessContext): void {
    if (!result.idempotentReplay) this.metrics.transactionsByStatus.inc({ status: result.status, kind: cmd.kind });
    this.logger.info(result.idempotentReplay ? 'wager transaction replayed' : 'wager transaction decided', {
      correlationId: ctx.correlationId,
      messageId: ctx.inbox?.messageId,
      transactionId: result.transactionId,
      walletId: cmd.walletId,
      providerId: cmd.providerId,
      kind: cmd.kind,
      status: result.status,
      failureCode: result.failureCode,
    });
  }

  private countStatus(txn: WagerTransaction): void {
    this.metrics.transactionsByStatus.inc({ status: txn.status, kind: txn.kind });
    this.logger.info('pending wager transaction resolved', {
      transactionId: txn.id,
      walletId: txn.walletId,
      providerId: txn.providerId,
      status: txn.status,
      failureCode: txn.failureCode,
    });
  }
}

export function toResult(txn: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: txn.id,
    status: txn.status,
    failureCode: txn.failureCode,
    balance: (txn.balanceAfter ?? Money.zero(txn.money.currency)).toJSON(),
    idempotentReplay,
  };
}
